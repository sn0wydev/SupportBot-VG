require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Bot, InlineKeyboard, Keyboard } = require('grammy');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_GROUP_ID = Number(process.env.SUPPORT_GROUP_ID); // e.g. -1001234567890
const DEV_COMMAND = 'cn34711'; // hidden alternate trigger, not registered with BotFather

// IMPORTANT (Railway): the container filesystem is wiped on every deploy.
// Attach a Volume (e.g. mount path /data) and set DATA_DIR=/data, otherwise
// every ticket is forgotten on each redeploy.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, 'tickets.json');

if (!BOT_TOKEN || !SUPPORT_GROUP_ID) {
  console.error('Missing BOT_TOKEN or SUPPORT_GROUP_ID — check your environment variables.');
  process.exit(1);
}

const parseIdSet = (v) => new Set((v || '').split(',').map((s) => s.trim()).filter(Boolean));

const ADMIN_IDS = parseIdSet(process.env.ADMIN_IDS);
const PRIZE_STORE_URL = (process.env.PRIZE_STORE_URL || '').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

const MANAGER_IDS = parseIdSet(process.env.MANAGER_IDS);
const PUSH_BRIDGE_URL = process.env.PUSH_BRIDGE_URL;
const PUSH_BRIDGE_SECRET = process.env.PUSH_BRIDGE_SECRET;

if (ADMIN_IDS.size === 0) console.warn('⚠️  ADMIN_IDS not set — admin commands are disabled for everyone.');
if (!PRIZE_STORE_URL || !ADMIN_API_KEY) console.warn('⚠️  PRIZE_STORE_URL / ADMIN_API_KEY not set — admin commands will fail.');
if (MANAGER_IDS.size === 0) console.warn('⚠️  MANAGER_IDS not set — /pushAnnounce is disabled for everyone.');
if (!PUSH_BRIDGE_URL || !PUSH_BRIDGE_SECRET) console.warn('⚠️  PUSH_BRIDGE_URL / PUSH_BRIDGE_SECRET not set — /pushAnnounce will fail.');

const isAdmin = (id) => ADMIN_IDS.has(String(id));
const isManager = (id) => MANAGER_IDS.has(String(id));
const isId = (s) => /^\d{1,15}$/.test(String(s || ''));

const bot = new Bot(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Storage
//
// Old format kept two separate copies of every ticket (byUser / byTopic).
// After a restart those copies were no longer the same object, so /close
// updated one copy but not the other — the user kept writing into a closed
// topic. New format: ONE record per ticket, plus two index maps that only
// store ticket numbers.
//
//   { nextTicketNumber, tickets: {num: ticket}, byUser: {userId: num}, byTopic: {topicId: num} }
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDB() {
  return { nextTicketNumber: 1, tickets: {}, byUser: {}, byTopic: {} };
}

function migrate(raw) {
  if (raw && raw.tickets) {
    return { ...emptyDB(), ...raw };
  }
  // Legacy format -> new format
  const db = emptyDB();
  db.nextTicketNumber = (raw && raw.nextTicketNumber) || 1;
  const legacy = [...Object.values((raw && raw.byUser) || {}), ...Object.values((raw && raw.byTopic) || {})];
  for (const t of legacy) {
    const prev = db.tickets[t.ticketNumber];
    db.tickets[t.ticketNumber] = prev
      ? { ...prev, ...t, closed: Boolean(prev.closed || t.closed), phone: t.phone || prev.phone || null }
      : { ...t };
  }
  const nums = Object.keys(db.tickets).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    const t = db.tickets[n];
    db.byTopic[t.topicId] = n;
    db.byUser[t.userId] = n; // ascending order -> newest ticket wins
    if (n >= db.nextTicketNumber) db.nextTicketNumber = n + 1;
  }
  return db;
}

function loadDB() {
  for (const p of [DB_PATH, `${DB_PATH}.bak`]) {
    if (!fs.existsSync(p)) continue;
    try {
      const db = migrate(JSON.parse(fs.readFileSync(p, 'utf8')));
      console.log(`[db] loaded ${Object.keys(db.tickets).length} ticket(s) from ${p}`);
      return db;
    } catch (err) {
      console.error(`[db] could not read ${p}:`, err.message);
    }
  }
  console.warn(`[db] no database found at ${DB_PATH} — starting EMPTY. If you expected existing tickets, your volume / DATA_DIR is not set up correctly.`);
  return emptyDB();
}

const db = loadDB();

// Atomic write: a crash mid-save can no longer corrupt tickets.json.
function saveDB() {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, `${DB_PATH}.bak`);
  fs.renameSync(tmp, DB_PATH);
}

const ticketByTopic = (topicId) => db.tickets[db.byTopic[topicId]] || null;
const latestTicketFor = (userId) => db.tickets[db.byUser[userId]] || null;
const openTicketFor = (userId) => {
  const t = latestTicketFor(userId);
  return t && !t.closed ? t : null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const userLink = (u) => (u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.id}`);
const escapeHtml = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fullName = (u) => `${u.first_name || ''} ${u.last_name || ''}`.trim() || '—';
const errText = (err) => err?.description || err?.message || String(err);

// Replies inside the same topic the command was typed in.
function replyInTopic(ctx, text, extra = {}) {
  const threadId = ctx.message?.message_thread_id;
  return ctx.reply(text, threadId ? { ...extra, message_thread_id: threadId } : extra);
}

// Only real content can be copied. Service messages ("topic closed", "pinned",
// "user joined"…) cause "the message can't be copied", so we whitelist instead.
const RELAYABLE = ['text', 'photo', 'video', 'document', 'audio', 'voice', 'video_note', 'animation', 'sticker', 'location', 'venue', 'contact', 'dice', 'poll'];
const isRelayable = (m) => RELAYABLE.some((k) => m[k] !== undefined);

const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_CLOSED|topic.*(deleted|closed)/i;

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
async function sendInfoCard(ticket, user) {
  const card = [
    `🎫 <b>Ticket #${ticket.ticketNumber}</b>`,
    `👤 Name: ${escapeHtml(fullName(user))}`,
    `🔗 Username: ${user.username ? '@' + escapeHtml(user.username) : '—'}`,
    `🆔 ID: <code>${user.id}</code>`,
    `📞 Phone (optional): ${ticket.phone ? escapeHtml(ticket.phone) : 'not shared'}`,
    `💬 Contact: <a href="${userLink(user)}">open chat</a>`,
  ].join('\n');

  await bot.api.sendMessage(SUPPORT_GROUP_ID, card, {
    message_thread_id: ticket.topicId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

async function createTicket(user) {
  const prev = latestTicketFor(user.id);
  const ticketNumber = db.nextTicketNumber;
  const title = `#${ticketNumber} · ${fullName(user)}`.slice(0, 128);

  const topic = await bot.api.createForumTopic(SUPPORT_GROUP_ID, title);

  // Only consume the number once Telegram confirmed the topic exists.
  db.nextTicketNumber = ticketNumber + 1;
  const ticket = {
    ticketNumber,
    topicId: topic.message_thread_id,
    userId: user.id,
    closed: false,
    phone: prev?.phone || null,
    createdAt: Date.now(),
  };
  db.tickets[ticketNumber] = ticket;
  db.byUser[user.id] = ticketNumber;
  db.byTopic[ticket.topicId] = ticketNumber;
  saveDB();

  // The ticket already exists; a failing info card must not lose it.
  await sendInfoCard(ticket, user).catch((err) => console.error('info card failed:', errText(err)));
  return ticket;
}

// One ticket creation per user at a time, so two quick messages can't spawn
// two topics.
const creating = new Map();
function getOrCreateTicket(user) {
  const open = openTicketFor(user.id);
  if (open) return Promise.resolve(open);
  if (creating.has(user.id)) return creating.get(user.id);
  const p = createTicket(user).finally(() => creating.delete(user.id));
  creating.set(user.id, p);
  return p;
}

async function closeTicket(ticket, { notifyUser = true } = {}) {
  if (ticket.closed) return false;
  ticket.closed = true;
  saveDB();
  if (notifyUser) {
    await bot.api
      .sendMessage(ticket.userId, 'This support ticket has been closed. Send a new message to start another.')
      .catch(() => {});
  }
  return true;
}

async function startTicketFlow(chatId, user) {
  try {
    await getOrCreateTicket(user);
  } catch (err) {
    console.error('createForumTopic failed:', errText(err));
    await bot.api.sendMessage(chatId, 'Support is temporarily unavailable, please try again shortly.').catch(() => {});
    return;
  }

  const keyboard = new Keyboard()
    .requestContact('📞 Share phone number (optional)')
    .row()
    .text('⏭ Skip')
    .resized()
    .oneTime();

  await bot.api.sendMessage(
    chatId,
    "You're connected to support. Send your message and we'll reply here.\n\nSharing your phone number is optional — tap Skip if you'd rather not.",
    { reply_markup: keyboard }
  );
}

// ---------------------------------------------------------------------------
// User-facing triggers (private chats only)
// ---------------------------------------------------------------------------
const isPrivate = (ctx) => ctx.chat?.type === 'private';

bot.command('start', async (ctx) => {
  if (!isPrivate(ctx)) return;
  const keyboard = new InlineKeyboard().text('📩 Contact Support', 'open_ticket');
  await ctx.reply('Need help? Tap below to talk to support.', { reply_markup: keyboard });
});

bot.command(DEV_COMMAND, async (ctx) => {
  if (!isPrivate(ctx)) return;
  await startTicketFlow(ctx.chat.id, ctx.from);
});

bot.command('createticket', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await startTicketFlow(ctx.chat.id, ctx.from);
});

bot.callbackQuery('open_ticket', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.chat && !isPrivate(ctx)) return;
  await startTicketFlow(ctx.from.id, ctx.from);
});

bot.hears('⏭ Skip', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await ctx.reply('No problem — support can still reach you without a phone number.', {
    reply_markup: { remove_keyboard: true },
  });
});

// Phone number: only ever arrives if the user taps the share-contact button.
bot.on('message:contact', async (ctx, next) => {
  if (!isPrivate(ctx)) return next();
  const ticket = openTicketFor(ctx.from.id);
  // Someone else's contact, or no open ticket -> treat as a normal message.
  if (!ticket || ctx.message.contact.user_id !== ctx.from.id) return next();

  ticket.phone = ctx.message.contact.phone_number;
  saveDB();

  await bot.api
    .sendMessage(SUPPORT_GROUP_ID, `📞 Phone number shared: <code>${escapeHtml(ticket.phone)}</code>`, {
      message_thread_id: ticket.topicId,
      parse_mode: 'HTML',
    })
    .catch((err) => console.error('phone notice failed:', errText(err)));

  await ctx.reply('Thanks — support has your number now.', { reply_markup: { remove_keyboard: true } });
});

// ---------------------------------------------------------------------------
// Staff commands inside the support group
// ---------------------------------------------------------------------------
bot.command('close', async (ctx) => {
  if (ctx.chat.id !== SUPPORT_GROUP_ID) return;
  const topicId = ctx.message.message_thread_id;
  const ticket = topicId ? ticketByTopic(topicId) : null;
  if (!ticket) {
    await replyInTopic(ctx, "This topic isn't linked to a user. Use /link <user_id> first.");
    return;
  }
  const changed = await closeTicket(ticket);
  await bot.api.closeForumTopic(SUPPORT_GROUP_ID, ticket.topicId).catch(() => {});
  await replyInTopic(ctx, changed ? 'Ticket closed.' : 'Ticket was already closed.');
});

// Recovery tool: re-connect a topic to a user (e.g. after the database was
// lost). The user's ID is printed in the first message of every ticket topic.
bot.command('link', async (ctx) => {
  if (ctx.chat.id !== SUPPORT_GROUP_ID) return;
  const topicId = ctx.message.message_thread_id;
  const arg = (ctx.match || '').trim();
  if (!topicId) {
    await ctx.reply('Run /link <user_id> inside the ticket topic you want to reconnect.');
    return;
  }
  if (!isId(arg)) {
    await replyInTopic(ctx, 'Usage: /link <user_id>   (the ID is in the first message of this topic)');
    return;
  }
  const userId = Number(arg);

  let ticket = ticketByTopic(topicId);
  if (ticket) {
    ticket.userId = userId;
    ticket.closed = false;
  } else {
    const ticketNumber = db.nextTicketNumber++;
    ticket = { ticketNumber, topicId, userId, closed: false, phone: null, createdAt: Date.now(), relinked: true };
    db.tickets[ticketNumber] = ticket;
    db.byTopic[topicId] = ticketNumber;
  }
  db.byUser[userId] = ticket.ticketNumber;
  saveDB();

  await bot.api.reopenForumTopic(SUPPORT_GROUP_ID, topicId).catch(() => {});

  let reachable = true;
  try {
    await bot.api.sendChatAction(userId, 'typing');
  } catch (err) {
    reachable = false;
    console.warn(`/link: user ${userId} not reachable:`, errText(err));
  }
  await replyInTopic(
    ctx,
    reachable
      ? `🔗 Linked. Messages in this topic now go to user ${userId}.`
      : `🔗 Linked to ${userId}, but the bot can't message them right now (they may have blocked it or never started it).`
  );
});

// Closing / reopening a topic from the Telegram UI keeps our records in sync.
bot.on('message:forum_topic_closed', async (ctx) => {
  if (ctx.chat.id !== SUPPORT_GROUP_ID) return;
  const t = ticketByTopic(ctx.message.message_thread_id);
  if (t) await closeTicket(t);
});

bot.on('message:forum_topic_reopened', async (ctx) => {
  if (ctx.chat.id !== SUPPORT_GROUP_ID) return;
  const t = ticketByTopic(ctx.message.message_thread_id);
  if (!t || !t.closed) return;
  t.closed = false;
  const current = latestTicketFor(t.userId);
  if (!current || current.closed || current.ticketNumber === t.ticketNumber) {
    db.byUser[t.userId] = t.ticketNumber;
  }
  saveDB();
});

// ---------------------------------------------------------------------------
// Admin commands (prize-store)
// ---------------------------------------------------------------------------
async function adminRequest(method, pathname, body) {
  const res = await fetch(`${PRIZE_STORE_URL}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function formatStats(userId, data) {
  const u = data.user || {};
  const prizes = data.prizes || [];
  const counts = data.counts || {};
  const countsLine = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';

  const lines = [
    `<b>Stats for ${escapeHtml(String(userId))}</b>`,
    `Coins: ${u.coins ?? 0}   ⭐ Stars: ${u.stars ?? 0}`,
    `Gifts (${prizes.length}): ${escapeHtml(countsLine)}`,
    '',
  ];

  if (prizes.length === 0) {
    lines.push('No prizes on record.');
    return lines.join('\n');
  }

  const widths = [12, 14, 10, 16];
  const shown = prizes.slice(0, 30);
  const rows = shown.map((p) => [
    String(p.prize_id || ''),
    String(p.gift_name || '').slice(0, widths[1]),
    String(p.status || ''),
    p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 16).replace('T', ' ') : '',
  ]);

  const header = ['prize_id', 'gift', 'status', 'updated'].map((h, i) => h.padEnd(widths[i])).join(' ');
  const sep = widths.map((w) => '-'.repeat(w)).join(' ');
  const body = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join(' ')).join('\n');

  lines.push(`<pre>${escapeHtml(`${header}\n${sep}\n${body}`)}</pre>`);
  if (prizes.length > shown.length) lines.push(`…and ${prizes.length - shown.length} more.`);
  return lines.join('\n');
}

bot.on('message:text', async (ctx, next) => {
  const inSupportGroup = ctx.chat.id === SUPPORT_GROUP_ID;
  if (ctx.chat.type !== 'private' && !inSupportGroup) return next();
  if (!isAdmin(ctx.from.id)) return next();

  const match = ctx.message.text.match(/^\/(addstars|removestars|addnft|addgift|getstats|getbalance)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return next();

  if (!PRIZE_STORE_URL || !ADMIN_API_KEY) {
    await replyInTopic(ctx, 'Admin commands are not configured — missing PRIZE_STORE_URL / ADMIN_API_KEY.');
    return;
  }

  const cmd = match[1].toLowerCase();
  const argStr = (match[2] || '').trim();
  const parts = argStr.split(/\s+/);
  const targetId = parts[0];
  const rest = parts.slice(1).join(' ').trim();
  const adminId = ctx.from.id;

  const usage = {
    getstats: '/getstats <user_id>',
    getbalance: '/getBalance <user_id>',
    removestars: '/removeStars <user_id>',
    addstars: '/addstars <user_id> <amount>  (amount can be negative)',
    addgift: '/addgift <user_id> <gift_name>',
    addnft: '/addnft <user_id> <type>',
  };
  if (!isId(targetId)) {
    await replyInTopic(ctx, `Usage: ${usage[cmd]}`);
    return;
  }

  try {
    if (cmd === 'getstats') {
      const data = await adminRequest('GET', `/admin/users/${targetId}/stats?admin_id=${adminId}`);
      await replyInTopic(ctx, formatStats(targetId, data), { parse_mode: 'HTML' });
    } else if (cmd === 'getbalance') {
      const data = await adminRequest('GET', `/admin/users/${targetId}/balance?admin_id=${adminId}`);
      const u = data.user || {};
      await replyInTopic(ctx, `💰 Balance for ${targetId}\nCoins: ${u.coins ?? 0}\n⭐ Stars: ${u.stars ?? 0}`);
    } else if (cmd === 'removestars') {
      const data = await adminRequest('DELETE', `/admin/users/${targetId}/stars`, { admin_id: adminId });
      await replyInTopic(ctx, `⭐ Removed all stars from ${targetId}. Previous balance: ${data.previous_stars}. New balance: ${data.stars}`);
    } else if (cmd === 'addstars') {
      const amount = parseInt(parts[1], 10);
      if (!Number.isFinite(amount) || amount === 0) {
        await replyInTopic(ctx, `Usage: ${usage.addstars}`);
        return;
      }
      const data = await adminRequest('POST', `/admin/users/${targetId}/stars`, { amount, admin_id: adminId });
      await replyInTopic(ctx, `⭐ ${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} star(s) for ${targetId}. New balance: ${data.stars}`);
    } else if (cmd === 'addgift') {
      if (!rest) {
        await replyInTopic(ctx, `Usage: ${usage.addgift}`);
        return;
      }
      const data = await adminRequest('POST', '/admin/gifts', { user_id: targetId, gift_name: rest, admin_id: adminId });
      await replyInTopic(ctx, `🎁 Added "${rest}" to ${targetId}'s inventory. Prize ID: ${data.prize.prize_id}`);
    } else if (cmd === 'addnft') {
      if (!rest) {
        await replyInTopic(ctx, `Usage: ${usage.addnft}`);
        return;
      }
      // ASSUMPTION (unchanged): nft_slug and gift_name are both the typed value.
      const data = await adminRequest('POST', '/admin/gifts', {
        user_id: targetId,
        gift_name: rest,
        nft_slug: rest,
        admin_id: adminId,
      });
      await replyInTopic(ctx, `🖼 Added NFT "${rest}" to ${targetId}'s inventory. Prize ID: ${data.prize.prize_id}`);
    }
  } catch (err) {
    console.error(`${cmd} failed:`, err.message);
    await replyInTopic(ctx, `Command failed: ${err.message}`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// /pushAnnounce — manager-only global broadcast
// ---------------------------------------------------------------------------
bot.command('pushAnnounce', async (ctx) => {
  if (!isManager(ctx.from.id)) {
    await replyInTopic(ctx, '🚫 Managers only.');
    return;
  }
  if (!PUSH_BRIDGE_URL || !PUSH_BRIDGE_SECRET) {
    await replyInTopic(ctx, 'Broadcast bridge is not configured — missing PUSH_BRIDGE_URL / PUSH_BRIDGE_SECRET.');
    return;
  }

  const text = (ctx.match || '').trim();
  const photo = ctx.message.photo;

  if (!text && !photo) {
    await replyInTopic(ctx, 'Usage: /pushAnnounce <message>  (optionally attach a photo — caption = command + text)');
    return;
  }

  let photoBase64 = null;
  let photoMime = null;

  if (photo) {
    try {
      const fileId = photo[photo.length - 1].file_id; // largest size
      const file = await ctx.api.getFile(fileId);
      const resp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`Telegram file download failed: HTTP ${resp.status}`);
      photoBase64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
      photoMime = 'image/jpeg';
    } catch (err) {
      console.error('pushAnnounce: failed to fetch photo:', err.message);
      await replyInTopic(ctx, 'Failed to fetch the photo from Telegram. Nothing was sent.');
      return;
    }
  }

  await replyInTopic(ctx, '📣 Broadcasting…');

  try {
    const resp = await fetch(PUSH_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-push-secret': PUSH_BRIDGE_SECRET },
      body: JSON.stringify({ managerId: ctx.from.id, text, photoBase64, photoMime }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    await replyInTopic(ctx, `✅ Sent to ${data.sent}/${data.total} users. (${data.blocked} blocked the bot, ${data.failed} failed.)`);
  } catch (err) {
    console.error('pushAnnounce: bridge request failed:', err.message);
    await replyInTopic(ctx, `Broadcast failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Relay (ONE handler — see grammy middleware notes in the original file)
// ---------------------------------------------------------------------------
async function relayUserMessage(ctx) {
  const copy = (ticket) =>
    ctx.api.copyMessage(SUPPORT_GROUP_ID, ctx.chat.id, ctx.message.message_id, {
      message_thread_id: ticket.topicId,
    });

  let ticket = await getOrCreateTicket(ctx.from);
  try {
    await copy(ticket);
    return;
  } catch (err) {
    if (!TOPIC_GONE.test(errText(err))) throw err;
    // Topic was deleted/closed behind our back: retire it and open a fresh one.
    console.warn(`Topic for ticket #${ticket.ticketNumber} is gone (${errText(err)}); opening a new ticket.`);
    ticket.closed = true;
    saveDB();
  }
  ticket = await getOrCreateTicket(ctx.from);
  await copy(ticket);
}

const hintedTopics = new Set();

async function relayStaffMessage(ctx) {
  const m = ctx.message;
  const topicId = m.message_thread_id;
  if (!topicId || m.from?.is_bot) return; // ignore "General" and bot messages
  if (!isRelayable(m)) return; // service messages
  if ((m.text || m.caption || '').startsWith('/')) return; // commands are never relayed

  const ticket = ticketByTopic(topicId);
  if (!ticket) {
    if (!hintedTopics.has(topicId)) {
      hintedTopics.add(topicId);
      await replyInTopic(
        ctx,
        "⚠️ This topic isn't linked to a user, so nothing was delivered. If it's a ticket topic, the user's ID is in its first message — run /link <user_id> to reconnect it."
      ).catch(() => {});
    }
    return;
  }

  try {
    await ctx.api.copyMessage(ticket.userId, ctx.chat.id, m.message_id);
  } catch (err) {
    const d = errText(err);
    console.error(`Relay to user ${ticket.userId} failed:`, d);
    let note;
    if (/blocked by the user/i.test(d)) note = '🚫 Not delivered — the user has blocked the bot.';
    else if (/deactivated|chat not found/i.test(d)) note = '🚫 Not delivered — this user account is unavailable.';
    else note = `⚠️ Not delivered: ${d}`;
    await ctx
      .reply(note, { message_thread_id: topicId, reply_parameters: { message_id: m.message_id } })
      .catch(() => {});
  }
}

bot.on('message', async (ctx) => {
  if (ctx.chat.type === 'private') {
    if (ctx.message.text && ctx.message.text.startsWith('/')) return; // unknown/handled commands
    try {
      await relayUserMessage(ctx);
    } catch (err) {
      console.error('Failed to relay user message:', errText(err));
      await ctx.reply("⚠️ We couldn't deliver your message just now. Please try again in a moment.").catch(() => {});
    }
    return;
  }

  if (ctx.chat.id === SUPPORT_GROUP_ID) {
    await relayStaffMessage(ctx);
  }
});

bot.catch((err) => {
  console.error('Unhandled bot error:', errText(err.error));
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------
async function checkSetup() {
  try {
    const chat = await bot.api.getChat(SUPPORT_GROUP_ID);
    if (!chat.is_forum) console.warn('⚠️  SUPPORT_GROUP_ID is not a forum (Topics are not enabled).');
    const me = await bot.api.getChatMember(SUPPORT_GROUP_ID, bot.botInfo.id);
    if (me.status !== 'administrator') {
      console.warn('⚠️  Bot is not an admin in the support group.');
    } else if (!me.can_manage_topics) {
      console.warn('⚠️  Bot is admin but lacks the "Manage topics" permission.');
    }
  } catch (err) {
    console.warn('⚠️  Could not verify the support group:', errText(err));
  }
}

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[shutdown] ${signal} received, stopping polling…`);
  setTimeout(() => process.exit(0), 5000).unref();
  Promise.resolve(bot.stop()).finally(() => process.exit(0));
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', errText(err)));

async function main() {
  while (!stopping) {
    try {
      await bot.start({
        onStart: (me) => {
          console.log(`Support bot running as @${me.username}`);
          checkSetup();
        },
      });
      return; // stopped on purpose
    } catch (err) {
      if (stopping) return;
      const conflict = err?.error_code === 409;
      console.error(
        conflict
          ? '[poll] 409 Conflict: another instance is polling this BOT_TOKEN. Retrying in 15s…'
          : `[poll] polling stopped: ${errText(err)}. Retrying in 5s…`
      );
      await new Promise((r) => setTimeout(r, conflict ? 15000 : 5000));
    }
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { migrate };
}
