require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Bot, InlineKeyboard, Keyboard } = require('grammy');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPPORT_GROUP_ID = Number(process.env.SUPPORT_GROUP_ID); // e.g. -1001234567890
const DEV_COMMAND = 'cn34711'; // hidden alternate trigger, not registered with BotFather
const DB_PATH = path.join(__dirname, 'tickets.json');

if (!BOT_TOKEN || !SUPPORT_GROUP_ID) {
  console.error('Missing BOT_TOKEN or SUPPORT_GROUP_ID — check your .env file.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Admin config — ADMIN: new
// ADMIN_IDS: comma-separated Telegram user IDs allowed to run /addstars,
// /addnft, /addgift, /getstats (e.g. "111111,222222").
// PRIZE_STORE_URL / ADMIN_API_KEY: how the bot reaches the prize-store's
// admin-only endpoints. ADMIN_API_KEY must match the same env var set on
// the prize-store service — it's the shared secret gating those routes,
// since prize-store's public endpoints have no auth at all right now.
// ---------------------------------------------------------------------------
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);
const PRIZE_STORE_URL = (process.env.PRIZE_STORE_URL || '').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (ADMIN_IDS.size === 0) {
  console.warn('⚠️  ADMIN_IDS not set — /addstars, /addnft, /addgift, /getstats are disabled for everyone.');
}
if (!PRIZE_STORE_URL || !ADMIN_API_KEY) {
  console.warn('⚠️  PRIZE_STORE_URL / ADMIN_API_KEY not set — admin commands will fail if anyone tries them.');
}

const bot = new Bot(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Tiny JSON-file "database". Fine for low/medium volume; swap for SQLite or
// Postgres if ticket volume grows or you need multiple bot instances.
// ---------------------------------------------------------------------------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { nextTicketNumber: 1, byUser: {}, byTopic: {} };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
const db = loadDB();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function userLink(user) {
  return user.username ? `https://t.me/${user.username}` : `tg://user?id=${user.id}`;
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fullName(user) {
  return `${user.first_name || ''} ${user.last_name || ''}`.trim() || '—';
}

// ---------------------------------------------------------------------------
// Admin helpers — ADMIN: new
// ---------------------------------------------------------------------------
function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

async function adminPost(pathname, body) {
  const res = await fetch(`${PRIZE_STORE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function adminGet(pathname) {
  const res = await fetch(`${PRIZE_STORE_URL}${pathname}`, {
    headers: { 'x-admin-key': ADMIN_API_KEY },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function adminDelete(pathname, body) {
  const res = await fetch(`${PRIZE_STORE_URL}${pathname}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Renders a /getstats reply: balance summary + a monospace table of the
// user's prizes, styled after the same rows the prize-store already
// tracks (prize_id, gift_name, status, updated_at).
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

async function getOrCreateTicket(user) {
  const existing = db.byUser[user.id];
  if (existing && !existing.closed) return existing;

  const ticketNumber = db.nextTicketNumber++;
  const title = `#${ticketNumber} · ${fullName(user)}`.slice(0, 128);

  const topic = await bot.api.createForumTopic(SUPPORT_GROUP_ID, title);

  const ticket = {
    ticketNumber,
    topicId: topic.message_thread_id,
    userId: user.id,
    closed: false,
    phone: existing?.phone || null,
  };
  db.byUser[user.id] = ticket;
  db.byTopic[ticket.topicId] = ticket;
  saveDB();

  const infoCard = [
    `🎫 <b>Ticket #${ticketNumber}</b>`,
    `👤 Name: ${escapeHtml(fullName(user))}`,
    `🔗 Username: ${user.username ? '@' + user.username : '—'}`,
    `🆔 ID: <code>${user.id}</code>`,
    `📞 Phone (optional): ${ticket.phone ? escapeHtml(ticket.phone) : 'not shared'}`,
    `💬 Contact: <a href="${userLink(user)}">open chat</a>`,
  ].join('\n');

  await bot.api.sendMessage(SUPPORT_GROUP_ID, infoCard, {
    message_thread_id: ticket.topicId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });

  return ticket;
}

async function startTicketFlow(chatId, user) {
  try {
    await getOrCreateTicket(user);
  } catch (err) {
    console.error('createForumTopic failed:', err.description || err.message);
    await bot.api.sendMessage(chatId, 'Support is temporarily unavailable, please try again shortly.');
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
// Triggers: /start button, hidden dev command, inline button callback
// ---------------------------------------------------------------------------
bot.command('start', async (ctx) => {
  const keyboard = new InlineKeyboard().text('📩 Contact Support', 'open_ticket');
  await ctx.reply('Need help? Tap below to talk to support.', { reply_markup: keyboard });
});

bot.command(DEV_COMMAND, async (ctx) => {
  await startTicketFlow(ctx.chat.id, ctx.from);
});

// Public alias for starting a ticket directly, without going through /start's button.
bot.command('createticket', async (ctx) => {
  await startTicketFlow(ctx.chat.id, ctx.from);
});

bot.callbackQuery('open_ticket', async (ctx) => {
  await startTicketFlow(ctx.chat.id, ctx.from);
  await ctx.answerCallbackQuery().catch(() => {});
});

// User tapped "Skip" instead of sharing their phone number — just dismiss
// the keyboard, don't relay "⏭ Skip" into the topic as a real message.
bot.hears('⏭ Skip', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  await ctx.reply('No problem — support can still reach you without a phone number.', {
    reply_markup: { remove_keyboard: true },
  });
});

// Phone number: only ever arrives if the user taps the share-contact button.
// The Bot API never exposes a phone number without that explicit action.
bot.on('message:contact', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const ticket = db.byUser[ctx.from.id];
  if (!ticket || ctx.message.contact.user_id !== ctx.from.id) return; // ignore forwarded contacts of others

  ticket.phone = ctx.message.contact.phone_number;
  saveDB();

  await bot.api.sendMessage(
    SUPPORT_GROUP_ID,
    `📞 Phone number shared: <code>${escapeHtml(ticket.phone)}</code>`,
    { message_thread_id: ticket.topicId, parse_mode: 'HTML' }
  );
  await ctx.reply('Thanks — support has your number now.', {
    reply_markup: { remove_keyboard: true },
  });
});

// ---------------------------------------------------------------------------
// Admin commands — ADMIN: new
// Private-chat only, sender must be in ADMIN_IDS. Registered before the
// catch-all relay handler below, and returns without calling next() once
// matched, so these never get created into a ticket or relayed anywhere.
// A non-admin (or a non-matching /command) just falls through to next(),
// so ordinary ticket flow is untouched.
//
//   /addstars    <user_id> <amount>   amount may be negative to deduct
//   /removeStars <user_id>            zeroes out the user's star balance
//   /addgift     <user_id> <gift_name>
//   /addnft      <user_id> <type>
//   /getstats    <user_id>            balances + full prize history
//   /getBalance  <user_id>            coins/stars only
//
// The write commands (addstars, removeStars, addgift, addnft) are logged
// server-side in prize-store's admin_actions table (admin_id, action,
// target_user_id, payload, created_at). getstats/getBalance are read-only
// and not logged.
// ---------------------------------------------------------------------------
bot.on('message:text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!isAdmin(ctx.from.id)) return next();

  const match = ctx.message.text.match(/^\/(addstars|removestars|addnft|addgift|getstats|getbalance)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) return next();

  if (!PRIZE_STORE_URL || !ADMIN_API_KEY) {
    await ctx.reply('Admin commands are not configured — missing PRIZE_STORE_URL / ADMIN_API_KEY.');
    return;
  }

  const cmd = match[1].toLowerCase();
  const argStr = (match[2] || '').trim();

  if (cmd === 'getstats') {
    const targetId = argStr.split(/\s+/)[0];
    if (!targetId || isNaN(Number(targetId))) {
      await ctx.reply('Usage: /getstats <user_id>');
      return;
    }
    try {
      const data = await adminGet(`/admin/users/${targetId}/stats?admin_id=${ctx.from.id}`);
      await ctx.reply(formatStats(targetId, data), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('getstats failed:', err.message);
      await ctx.reply(`Failed to fetch stats: ${err.message}`);
    }
    return;
  }

  if (cmd === 'getbalance') {
    const targetId = argStr.split(/\s+/)[0];
    if (!targetId || isNaN(Number(targetId))) {
      await ctx.reply('Usage: /getBalance <user_id>');
      return;
    }
    try {
      const data = await adminGet(`/admin/users/${targetId}/balance?admin_id=${ctx.from.id}`);
      const u = data.user || {};
      await ctx.reply(`💰 Balance for ${targetId}\nCoins: ${u.coins ?? 0}\n⭐ Stars: ${u.stars ?? 0}`);
    } catch (err) {
      console.error('getbalance failed:', err.message);
      await ctx.reply(`Failed to fetch balance: ${err.message}`);
    }
    return;
  }

  if (cmd === 'removestars') {
    const targetId = argStr.split(/\s+/)[0];
    if (!targetId || isNaN(Number(targetId))) {
      await ctx.reply('Usage: /removeStars <user_id>');
      return;
    }
    try {
      const data = await adminDelete(`/admin/users/${targetId}/stars`, { admin_id: ctx.from.id });
      await ctx.reply(`⭐ Removed all stars from ${targetId}. Previous balance: ${data.previous_stars}. New balance: ${data.stars}`);
    } catch (err) {
      console.error('removestars failed:', err.message);
      await ctx.reply(`Failed to remove stars: ${err.message}`);
    }
    return;
  }

  if (cmd === 'addstars') {
    const [targetId, amountStr] = argStr.split(/\s+/);
    const amount = parseInt(amountStr, 10);
    if (!targetId || isNaN(Number(targetId)) || !Number.isFinite(amount) || amount === 0) {
      await ctx.reply('Usage: /addstars <user_id> <amount>  (amount can be negative)');
      return;
    }
    try {
      const data = await adminPost(`/admin/users/${targetId}/stars`, { amount, admin_id: ctx.from.id });
      await ctx.reply(`⭐ ${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} star(s) for ${targetId}. New balance: ${data.stars}`);
    } catch (err) {
      console.error('addstars failed:', err.message);
      await ctx.reply(`Failed to add stars: ${err.message}`);
    }
    return;
  }

  if (cmd === 'addgift') {
    const parts = argStr.split(/\s+/);
    const targetId = parts[0];
    const giftName = parts.slice(1).join(' ').trim();
    if (!targetId || isNaN(Number(targetId)) || !giftName) {
      await ctx.reply('Usage: /addgift <user_id> <gift_name>');
      return;
    }
    try {
      const data = await adminPost('/admin/gifts', { user_id: targetId, gift_name: giftName, admin_id: ctx.from.id });
      await ctx.reply(`🎁 Added "${giftName}" to ${targetId}'s inventory. Prize ID: ${data.prize.prize_id}`);
    } catch (err) {
      console.error('addgift failed:', err.message);
      await ctx.reply(`Failed to add gift: ${err.message}`);
    }
    return;
  }

  if (cmd === 'addnft') {
    const parts = argStr.split(/\s+/);
    const targetId = parts[0];
    const nftType = parts.slice(1).join(' ').trim();
    if (!targetId || isNaN(Number(targetId)) || !nftType) {
      await ctx.reply('Usage: /addnft <user_id> <type>');
      return;
    }
    try {
      // ASSUMPTION: nft_slug is what the claim/relayer side keys off for NFT
      // delivery, and gift_name is just the display string shown in the
      // inventory UI — I set both to the same typed value. I don't have the
      // gift-relayer's source, so if your NFT slugs follow a different
      // format (a catalog key vs a free-text name), this is the line to
      // adjust: `nft_slug: nftType` below.
      const data = await adminPost('/admin/gifts', {
        user_id: targetId,
        gift_name: nftType,
        nft_slug: nftType,
        admin_id: ctx.from.id,
      });
      await ctx.reply(`🖼 Added NFT "${nftType}" to ${targetId}'s inventory. Prize ID: ${data.prize.prize_id}`);
    } catch (err) {
      console.error('addnft failed:', err.message);
      await ctx.reply(`Failed to add NFT: ${err.message}`);
    }
    return;
  }
});

// ---------------------------------------------------------------------------
// Relay: user DM <-> topic (must be ONE handler — grammy stops the whole
// middleware chain if a handler returns without calling next(), so two
// separate bot.on('message', ...) blocks meant the DM->topic handler's early
// `return` for group messages silently prevented the topic->DM handler
// below it from ever running. That's why staff replies never reached users.)
// ---------------------------------------------------------------------------
bot.on('message', async (ctx) => {
  // --- Direction 1: user DM -> topic ---
  if (ctx.chat.type === 'private') {
    if (ctx.message.contact) return; // handled above
    if (ctx.message.text && ctx.message.text.startsWith('/')) return; // commands handled above

    let ticket;
    try {
      ticket = await getOrCreateTicket(ctx.from);
    } catch (err) {
      console.error('createForumTopic failed:', err.description || err.message);
      return;
    }

    try {
      await bot.api.copyMessage(SUPPORT_GROUP_ID, ctx.chat.id, ctx.message.message_id, {
        message_thread_id: ticket.topicId,
      });
    } catch (err) {
      console.error('Failed to relay user message:', err.description || err.message);
    }
    return;
  }

  // --- Direction 2: topic -> user DM (+ /close typed inside a ticket topic) ---
  if (ctx.chat.id === SUPPORT_GROUP_ID) {
    if (!ctx.message.message_thread_id) return; // ignore messages in "General"

    const ticket = db.byTopic[ctx.message.message_thread_id];
    if (!ticket) return;

    if (ctx.message.text === '/close') {
      ticket.closed = true;
      saveDB();
      await bot.api.closeForumTopic(SUPPORT_GROUP_ID, ticket.topicId).catch(() => {});
      await ctx.reply('Ticket closed.', { message_thread_id: ticket.topicId });
      await bot.api.sendMessage(
        ticket.userId,
        'This support ticket has been closed. Send a new message to start another.'
      ).catch(() => {});
      return;
    }

    try {
      await bot.api.copyMessage(ticket.userId, ctx.chat.id, ctx.message.message_id);
    } catch (err) {
      console.error('Failed to relay staff message (user may have blocked the bot):', err.description || err.message);
    }
  }
});

bot.catch((err) => {
  console.error('Unhandled bot error:', err.error?.description || err.error?.message || err);
});

bot.start();
console.log('Support bot running.');
