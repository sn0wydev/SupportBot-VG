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
//   { nextTicketNumber, tickets: {num: ticket}, byUser: {userId: num}, byTopic: {topicId: num}, users: {userId: {lang}} }
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDB() {
  return { nextTicketNumber: 1, tickets: {}, byUser: {}, byTopic: {}, users: {} };
}

function migrate(raw) {
  if (raw && raw.tickets) {
    return { ...emptyDB(), ...raw, users: raw.users || {} };
  }
  // Legacy format -> new format
  const db = emptyDB();
  db.nextTicketNumber = (raw && raw.nextTicketNumber) || 1;
  const legacy = [...Object.values((raw && raw.byUser) || {}), ...Object.values((raw && raw.byTopic) || {})];
  for (const t of legacy) {
    const prev = db.tickets[t.ticketNumber];
    db.tickets[t.ticketNumber] = prev
      ? { ...prev, ...t, closed: Boolean(prev.closed || t.closed) }
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
// Languages & help categories
// ---------------------------------------------------------------------------
// Players pick a language once (stored per user). Everything the PLAYER sees —
// menus, buttons, tips, confirmations and the bot's command list — comes from
// I18N below. Anything the STAFF sees (info cards, /close, errors) stays English.
// To add a language: add it to LANGS, I18N and COMMANDS.
// ---------------------------------------------------------------------------
const DEFAULT_LANG = 'en';
const LANGS = { en: '🇬🇧 English', ru: '🇷🇺 Русский' };
const CATEGORY_IDS = ['gift', 'stars', 'sub', 'nft', 'payment'];
const STAFF_CATEGORY = {
  gift: "Gift wasn't claimed",
  stars: 'Stars balance not received',
  sub: 'Subscription check trouble',
  nft: 'NFT gift question',
  payment: 'Payment problem',
  other: 'Other question',
};

const I18N = {
  en: {
    pick_language: 'Please choose your language / Пожалуйста, выберите язык',
    lang_saved: 'Language: English',
    menu_title: 'Hi! 👋 How can we help?\nPick a topic below.',
    btn_language: '🌐 Language',
    btn_contact: '📩 Contact support',
    btn_back: '⬅️ Back',
    cat_gift: "🎁 Gift wasn't claimed",
    cat_stars: "⭐ Stars balance isn't received",
    cat_sub: '✅ Subscription check trouble',
    cat_nft: '🖼 NFT gift question',
    cat_payment: '💳 Payment problem',
    cat_other: '❓ Other question',
    tip_gift:
      "<b>🎁 Gift wasn't claimed</b>\n\n" +
      '• Make sure you tapped “Claim Prize” in the app and saw the confirmation.\n' +
      '• Gifts come from @VoidGift_Relayer. If you have never opened that chat, open it, press Start, then claim again.\n' +
      '• Check that your Telegram privacy settings allow receiving gifts.\n' +
      '• Regular gifts arrive within minutes. NFT gifts are delivered within 48 hours.\n\n' +
      'Still nothing? Contact support and include your Prize ID.',
    tip_stars:
      "<b>⭐ Stars balance isn't received</b>\n\n" +
      '• Close and reopen the Mini App — purchased Stars are added when it loads.\n' +
      '• Wait about a minute and try again.\n' +
      '• Keep the payment receipt from Telegram.\n\n' +
      'Still missing? Contact support and send the receipt or Charge ID.',
    tip_sub:
      '<b>✅ Subscription check trouble</b>\n\n' +
      '• Join our channel @VoidGiftsOfficial (opening it is not enough — press Join).\n' +
      '• Go back to the app and tap OK.\n' +
      '• Already joined? Wait 10 seconds and tap OK again, or restart the app.\n\n' +
      'Still failing? Contact support — we can verify you manually.',
    tip_nft:
      '<b>🖼 NFT gift question</b>\n\n' +
      '• Every NFT claim needs a fresh top-up of at least 25 Stars.\n' +
      '• After you claim, the NFT is transferred within 48 hours from @VoidGift_Relayer. Open that chat and press Start so it can reach you.\n' +
      '• You can follow the countdown in your Inventory.\n\n' +
      'Something wrong? Contact support and include your Prize ID.',
    tip_payment:
      '<b>💳 Payment problem</b>\n\n' +
      '• If Telegram charged you but nothing arrived, restart the app first.\n' +
      '• Keep the payment receipt.\n\n' +
      'Then contact support and send the receipt or Charge ID.',
    connected: "You're connected to support. Describe your problem in one message and we'll reply here.",
    ticket_closed: 'This support ticket has been closed. Use /start to open a new one.',
    support_down: 'Support is temporarily unavailable, please try again shortly.',
    relay_failed: "⚠️ We couldn't deliver your message just now. Please try again in a moment.",
  },
  ru: {
    pick_language: 'Please choose your language / Пожалуйста, выберите язык',
    lang_saved: 'Язык: Русский',
    menu_title: 'Привет! 👋 Чем помочь?\nВыберите тему ниже.',
    btn_language: '🌐 Язык',
    btn_contact: '📩 Написать в поддержку',
    btn_back: '⬅️ Назад',
    cat_gift: '🎁 Подарок не пришёл',
    cat_stars: '⭐ Stars не зачислены',
    cat_sub: '✅ Проблема с проверкой подписки',
    cat_nft: '🖼 Вопрос по NFT-подарку',
    cat_payment: '💳 Проблема с оплатой',
    cat_other: '❓ Другой вопрос',
    tip_gift:
      '<b>🎁 Подарок не пришёл</b>\n\n' +
      '• Убедитесь, что нажали «Забрать» в приложении и увидели подтверждение.\n' +
      '• Подарки приходят от @VoidGift_Relayer. Если вы ни разу не открывали этот чат — откройте его, нажмите Start и снова заберите подарок.\n' +
      '• Проверьте, что в настройках приватности Telegram разрешено получать подарки.\n' +
      '• Обычные подарки приходят в течение нескольких минут. NFT-подарки доставляются в течение 48 часов.\n\n' +
      'Всё равно не пришло? Напишите в поддержку и укажите Prize ID.',
    tip_stars:
      '<b>⭐ Stars не зачислены</b>\n\n' +
      '• Закройте и снова откройте мини-приложение — купленные Stars добавляются при загрузке.\n' +
      '• Подождите около минуты и попробуйте ещё раз.\n' +
      '• Сохраните чек об оплате из Telegram.\n\n' +
      'Не появились? Напишите в поддержку и пришлите чек или Charge ID.',
    tip_sub:
      '<b>✅ Проблема с проверкой подписки</b>\n\n' +
      '• Вступите в наш канал @VoidGiftsOfficial (просто открыть мало — нажмите «Подписаться»).\n' +
      '• Вернитесь в приложение и нажмите OK.\n' +
      '• Уже подписаны? Подождите 10 секунд и нажмите OK ещё раз или перезапустите приложение.\n\n' +
      'Не помогло? Напишите в поддержку — мы проверим вас вручную.',
    tip_nft:
      '<b>🖼 Вопрос по NFT-подарку</b>\n\n' +
      '• Для каждого NFT нужно новое пополнение минимум на 25 Stars.\n' +
      '• После получения NFT переводится в течение 48 часов от @VoidGift_Relayer. Откройте этот чат и нажмите Start, чтобы он мог вам написать.\n' +
      '• Обратный отсчёт виден в Инвентаре.\n\n' +
      'Что-то не так? Напишите в поддержку и укажите Prize ID.',
    tip_payment:
      '<b>💳 Проблема с оплатой</b>\n\n' +
      '• Если Telegram списал оплату, но ничего не пришло — сначала перезапустите приложение.\n' +
      '• Сохраните чек об оплате.\n\n' +
      'Затем напишите в поддержку и пришлите чек или Charge ID.',
    connected: 'Вы подключены к поддержке. Опишите проблему одним сообщением — мы ответим здесь.',
    ticket_closed: 'Обращение закрыто. Нажмите /start, чтобы открыть новое.',
    support_down: 'Поддержка временно недоступна, попробуйте чуть позже.',
    relay_failed: '⚠️ Не удалось доставить ваше сообщение. Попробуйте ещё раз через минуту.',
  },
};

const COMMANDS = {
  en: [
    { command: 'start', description: 'Open the help menu' },
    { command: 'createticket', description: 'Contact support' },
    { command: 'language', description: 'Change language' },
  ],
  ru: [
    { command: 'start', description: 'Открыть меню помощи' },
    { command: 'createticket', description: 'Связаться с поддержкой' },
    { command: 'language', description: 'Сменить язык' },
  ],
};

const t = (lang, key) => (I18N[lang] || I18N[DEFAULT_LANG])[key] ?? I18N[DEFAULT_LANG][key] ?? key;
const langOf = (userId) => db.users[userId]?.lang || null;
const langOrDefault = (userId) => langOf(userId) || DEFAULT_LANG;

function setLang(userId, lang) {
  db.users[userId] = { ...(db.users[userId] || {}), lang };
  saveDB();
}

function languageKeyboard() {
  const kb = new InlineKeyboard();
  for (const [code, label] of Object.entries(LANGS)) kb.text(label, `lang:${code}`);
  return kb;
}

function menuKeyboard(lang) {
  const kb = new InlineKeyboard();
  for (const id of CATEGORY_IDS) kb.text(t(lang, `cat_${id}`), `cat:${id}`).row();
  kb.text(t(lang, 'cat_other'), 'cat:other').row();
  kb.text(t(lang, 'btn_language'), 'langmenu');
  return kb;
}

// Telegram shows the command list per language; also pin the chosen language
// for this particular chat so "/" shows the right descriptions even if their
// Telegram app language is different. Best effort — never blocks the flow.
async function applyCommandsFor(userId, lang) {
  try {
    await bot.api.setMyCommands(COMMANDS[lang] || COMMANDS[DEFAULT_LANG], { scope: { type: 'chat', chat_id: userId } });
  } catch (err) {
    console.warn('setMyCommands(chat) failed:', errText(err));
  }
}

async function registerCommands() {
  try {
    await bot.api.setMyCommands(COMMANDS.en, { scope: { type: 'all_private_chats' } });
    await bot.api.setMyCommands(COMMANDS.ru, { scope: { type: 'all_private_chats' }, language_code: 'ru' });
  } catch (err) {
    console.warn('setMyCommands failed:', errText(err));
  }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
async function sendInfoCard(ticket, user) {
  const card = [
    `🎫 <b>Ticket #${ticket.ticketNumber}</b>`,
    `👤 Name: ${escapeHtml(fullName(user))}`,
    `🔗 Username: ${user.username ? '@' + escapeHtml(user.username) : '—'}`,
    `🆔 ID: <code>${user.id}</code>`,
    `🏷 Topic: ${escapeHtml(STAFF_CATEGORY[ticket.category] || STAFF_CATEGORY.other)}`,
    `🌐 Language: ${escapeHtml(LANGS[langOf(user.id)] || LANGS[DEFAULT_LANG])}`,
    `💬 Contact: <a href="${userLink(user)}">open chat</a>`,
  ].join('\n');

  await bot.api.sendMessage(SUPPORT_GROUP_ID, card, {
    message_thread_id: ticket.topicId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

async function createTicket(user, category = 'other') {
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
    category,
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
function getOrCreateTicket(user, category = 'other') {
  const open = openTicketFor(user.id);
  if (open) return Promise.resolve(open);
  if (creating.has(user.id)) return creating.get(user.id);
  const p = createTicket(user, category).finally(() => creating.delete(user.id));
  creating.set(user.id, p);
  return p;
}

async function closeTicket(ticket, { notifyUser = true } = {}) {
  if (ticket.closed) return false;
  ticket.closed = true;
  saveDB();
  if (notifyUser) {
    await bot.api.sendMessage(ticket.userId, t(langOrDefault(ticket.userId), 'ticket_closed')).catch(() => {});
  }
  return true;
}

async function startTicketFlow(chatId, user, category = 'other') {
  const lang = langOrDefault(user.id);
  let ticket;
  try {
    ticket = await getOrCreateTicket(user, category);
  } catch (err) {
    console.error('createForumTopic failed:', errText(err));
    await bot.api.sendMessage(chatId, t(lang, 'support_down')).catch(() => {});
    return;
  }

  // Already had an open ticket and picked a different topic now: tell staff.
  if (ticket.category !== category && category !== 'other') {
    ticket.category = category;
    saveDB();
    await bot.api
      .sendMessage(SUPPORT_GROUP_ID, `🏷 Topic updated: ${STAFF_CATEGORY[category]}`, { message_thread_id: ticket.topicId })
      .catch(() => {});
  }

  await bot.api.sendMessage(chatId, t(lang, 'connected'), { reply_markup: { remove_keyboard: true } });
}

// ---------------------------------------------------------------------------
// User-facing triggers (private chats only)
// ---------------------------------------------------------------------------
const isPrivate = (ctx) => ctx.chat?.type === 'private';

async function showLanguagePicker(chatId) {
  await bot.api.sendMessage(chatId, t(DEFAULT_LANG, 'pick_language'), { reply_markup: languageKeyboard() });
}

// Shows the help menu — or the language picker first if they haven't chosen.
async function showMenuOrPicker(chatId, userId) {
  const lang = langOf(userId);
  if (!lang) return showLanguagePicker(chatId);
  await bot.api.sendMessage(chatId, t(lang, 'menu_title'), { reply_markup: menuKeyboard(lang) });
}

bot.command('start', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await showMenuOrPicker(ctx.chat.id, ctx.from.id);
});

bot.command('help', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await showMenuOrPicker(ctx.chat.id, ctx.from.id);
});

bot.command('language', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await showLanguagePicker(ctx.chat.id);
});

// "Create a ticket" also asks for the language first when it isn't known,
// then shows the topic menu (every topic ends in a "Contact support" button).
bot.command('createticket', async (ctx) => {
  if (!isPrivate(ctx)) return;
  await showMenuOrPicker(ctx.chat.id, ctx.from.id);
});

bot.command(DEV_COMMAND, async (ctx) => {
  if (!isPrivate(ctx)) return;
  if (!langOf(ctx.from.id)) return showLanguagePicker(ctx.chat.id);
  await startTicketFlow(ctx.chat.id, ctx.from, 'other');
});

// Language chosen -> remember it, switch the command list, show the menu.
bot.callbackQuery(/^lang:(\w+)$/, async (ctx) => {
  if (ctx.chat && !isPrivate(ctx)) return ctx.answerCallbackQuery().catch(() => {});
  const lang = ctx.match[1];
  if (!LANGS[lang]) return ctx.answerCallbackQuery().catch(() => {});
  setLang(ctx.from.id, lang);
  await ctx.answerCallbackQuery({ text: t(lang, 'lang_saved') }).catch(() => {});
  await ctx.editMessageText(t(lang, 'menu_title'), { reply_markup: menuKeyboard(lang) }).catch(() => {});
  applyCommandsFor(ctx.from.id, lang);
});

bot.callbackQuery('langmenu', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageText(t(DEFAULT_LANG, 'pick_language'), { reply_markup: languageKeyboard() }).catch(() => {});
});

bot.callbackQuery('menu', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const lang = langOf(ctx.from.id);
  if (!lang) return showLanguagePicker(ctx.from.id);
  await ctx.editMessageText(t(lang, 'menu_title'), { reply_markup: menuKeyboard(lang) }).catch(() => {});
});

// A help topic: show the self-help tip with "Contact support" / "Back".
// "Other question" has no tip — it goes straight to support.
bot.callbackQuery(/^cat:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.chat && !isPrivate(ctx)) return;
  const id = ctx.match[1];
  const lang = langOrDefault(ctx.from.id);

  if (id === 'other') return startTicketFlow(ctx.from.id, ctx.from, 'other');
  if (!CATEGORY_IDS.includes(id)) return;

  const kb = new InlineKeyboard().text(t(lang, 'btn_contact'), `ticket:${id}`).row().text(t(lang, 'btn_back'), 'menu');
  await ctx.editMessageText(t(lang, `tip_${id}`), { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
});

bot.callbackQuery(/^ticket:(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.chat && !isPrivate(ctx)) return;
  const id = ctx.match[1];
  await startTicketFlow(ctx.from.id, ctx.from, CATEGORY_IDS.includes(id) ? id : 'other');
});

// Old "Contact Support" buttons from earlier versions of this bot still
// sitting in people's chats.
bot.callbackQuery('open_ticket', async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.chat && !isPrivate(ctx)) return;
  await showMenuOrPicker(ctx.from.id, ctx.from.id);
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
    ticket = { ticketNumber, topicId, userId, closed: false, category: 'other', createdAt: Date.now(), relinked: true };
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
    `Subscription: ${u.subscription_override ? '✅ manually set (override)' : 'checked normally'}`,
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

  const match = ctx.message.text.match(/^\/(addstars|removestars|addnft|addgift|getstats|getbalance|setsub|grantnft)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
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
    grantnft: '/grantnft <user_id> [count]   (gives free NFT-claim unlocks, normally earned by a 25+ Stars top-up)',
    setsub: '/setsub <user_id> [true|false]   (true = mark as subscribed, false = remove the manual flag; default true)',
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
    } else if (cmd === 'grantnft') {
      const count = parts[1] ? parseInt(parts[1], 10) : 1;
      if (!Number.isFinite(count) || count < 1 || count > 20) {
        await replyInTopic(ctx, `Usage: ${usage.grantnft}`);
        return;
      }
      const data = await adminRequest('POST', `/admin/users/${targetId}/nft-credits`, { count, admin_id: adminId });
      await replyInTopic(ctx, `🖼 Granted ${data.granted} NFT unlock(s) to ${targetId}. Available now: ${data.available}`);
    } else if (cmd === 'setsub') {
      const flag = (parts[1] || 'true').toLowerCase();
      if (!['true', 'false', 'on', 'off', '1', '0'].includes(flag)) {
        await replyInTopic(ctx, `Usage: ${usage.setsub}`);
        return;
      }
      const subscribed = ['true', 'on', '1'].includes(flag);
      await adminRequest('POST', `/admin/users/${targetId}/subscription`, { subscribed, admin_id: adminId });
      await replyInTopic(
        ctx,
        subscribed
          ? `✅ ${targetId} is now marked as subscribed — the channel check is skipped for them (takes effect within ~30s).`
          : `↩️ Manual subscription flag removed for ${targetId} — they're checked against the channel again.`
      );
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
      await ctx.reply(t(langOrDefault(ctx.from.id), 'relay_failed')).catch(() => {});
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
          registerCommands();
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
  module.exports = { migrate, bot, db };
}
