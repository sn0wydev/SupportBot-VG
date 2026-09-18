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