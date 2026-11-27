// IITALY — прокси для ИИ-чата (production-ready)
// Запуск локально: ANTHROPIC_API_KEY=sk-... node server.js
// Деплой: Railway / Render — ключ в env-переменной ANTHROPIC_API_KEY

const express = require("express");
const fs = require("fs");
const { normalizeApiKey, anthropicHeaders, createAiReadiness } = require("./ai-readiness");
const { buildDocumentReviewContext, documentContextPrompt, normalizeDocumentResult } = require("./document-review-context");
const { sanitizePortalDocumentResult } = require("./portal-document-report");
const { buildRoadmap, defaultIntakeYear, profileReady, needsTwelveYears } = require("./roadmap");
const { createReminderRunner, RETRY_MS, SEND_WINDOW, LATE_WINDOW_DAYS, inSendWindow, ruDate } = require("./reminders");
const { sendTelegramReminder } = require("./reminder-telegram");
const { makeLinkToken, findClientByToken } = require("./telegram-linking");
const { createOrderStore } = require("./order-store");
const { phoneKey, findRecoveryMatches, createRecoveryCooldown, deliverRecovery } = require("./portal-recovery");
const { CURRENCY: STRIPE_CURRENCY, minorUnits, createCheckoutSession, parseVerifiedEvent } = require("./stripe-checkout");
const { requestIdentity, createWindowCounter, createDualLimit, createBudget, safeEqual, makeAccessCode,
  createCappedLog, validEmail, plainText } = require("./request-guard");

/* ---------- Почта ----------
   Настраивается переменными SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM.
   Для Gmail нужен пароль приложения, обычный пароль не подойдёт. */
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE) === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log("Почта настроена: " + process.env.SMTP_HOST);
  } catch (e) {
    console.warn("WARN: не удалось настроить почту — " + e.message);
  }
} else {
  console.log("Почта не настроена (нет SMTP_HOST/USER/PASS) — письма отключены");
}

async function sendMail(to, subject, text) {
  if (!mailer || !to) return false;
  try {
    const info = await mailer.sendMail({
      from: process.env.SMTP_FROM || ("IITALY <" + process.env.SMTP_USER + ">"),
      to, subject, text,
    });
    // SMTP acceptance for THIS recipient, not just a resolved promise.
    return Array.isArray(info.accepted) && info.accepted.some(address =>
      String(typeof address === "string" ? address : address.address).toLowerCase() === to.toLowerCase());
  } catch (e) {
    console.error("mail failed");
    return false;
  }
}
/* Источники, которым разрешено ходить в API из браузера.
   Пример: ALLOWED_ORIGINS=https://iitaly.kz,https://www.iitaly.kz,https://iitaly.netlify.app
   Пустое значение = разрешено всем (старое поведение, см. предупреждение при старте). */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
// 8 МБ: фото документа в base64 весит 1-6 МБ. Чат и заказы валидируются отдельно по длине.
// CORS: без этих заголовков браузер не пустит запрос ни с сайта на Netlify,
// ни со страницы выдачи доступа, открытой локально (там origin = "null").
app.use((req, res, next) => {
  // базовые заголовки: браузер не угадывает тип файла, не отдаёт реферер,
  // страница не встраивается в чужой iframe
  res.header("X-Content-Type-Options", "nosniff");
  res.header("Referrer-Policy", "strict-origin-when-cross-origin");
  res.header("X-Frame-Options", "DENY");
  /* Security pass, 27 Nov: the server answers with JSON only, so nothing it
     returns may run scripts, be cached by a proxy on the way or reveal the
     framework. HSTS keeps the direct Railway address on HTTPS too. */
  res.removeHeader("X-Powered-By");
  res.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.header("Cache-Control", "no-store");
  /* Раньше здесь всегда стояла звёздочка: любой сайт в интернете мог
     дёргать наш API из браузера посетителя, включая кабинет. Теперь
     список разрешённых источников задаётся переменной ALLOWED_ORIGINS
     (через запятую). Пока она не задана, поведение прежнее — звёздочка
     и предупреждение в логах при старте, чтобы выкатка бэкенда не
     положила работающий сайт до того, как переменную пропишут. */
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.length) {
    res.header("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");   // иначе CDN отдаст чужому сайту чужой заголовок
  } else if (origin === "null" && req.path.startsWith("/api/admin/")) {
    // Private tools/admin.html is intentionally not published with the site.
    // A local file:// page has Origin: null; only admin routes allow it, and
    // every admin handler still requires Authorization: Bearer STATS_KEY.
    res.header("Access-Control-Allow-Origin", "null");
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);   // preflight
  next();
});

/* Only the document check carries a file. Everything else is a few fields,
   and the old single 8 MB limit let any address make the server parse 8 MB
   on every route. Chat: up to 40 messages with the site's reference text. */
const documentParser = express.json({ limit: "8mb" });
const chatParser = express.json({ limit: "512kb" });
const jsonParser = express.json({ limit: "256kb" });
const stripeRawParser = express.raw({ type: "application/json", limit: "1mb" });
app.use((req, res, next) => {
  if (req.path === "/api/stripe/webhook") return stripeRawParser(req, res, next);
  if (req.path === "/api/check-document") return documentParser(req, res, next);
  if (req.path === "/api/chat") return chatParser(req, res, next);
  return jsonParser(req, res, next);
});

// Ошибки разбора тела отдаём как JSON, а не HTML-страницей
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    const text = req.path === "/api/check-document"
      ? "Файл слишком большой. Сожми фото или сними при меньшем разрешении."
      : "Запрос слишком большой.";
    return res.status(413).json({ ok: false, reply: text, error: text });
  }
  if (err && err.status === 400 && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Некорректный формат запроса." });
  }
  next(err);
});

const SYSTEM_PROMPT = fs.readFileSync(__dirname + "/system-prompt.txt", "utf8");

/* ---------- Хранилище кабинетов ----------
   Файловая система Railway стирается при передеплое, поэтому данные клиентов
   пишем в примонтированный том. Путь задаётся переменной DATA_DIR.
   Если тома нет, работаем локально и предупреждаем в логах. */
const DATA_DIR = process.env.DATA_DIR || "/data";
let STORE_DIR = DATA_DIR;
try {
  fs.mkdirSync(DATA_DIR + "/clients", { recursive: true });
} catch (e) {
  STORE_DIR = __dirname + "/.data";
  try { fs.mkdirSync(STORE_DIR + "/clients", { recursive: true }); } catch (e2) {}
  console.warn("WARN: постоянный том недоступен, кабинеты хранятся временно в " + STORE_DIR);
}
/* Код доступа попадает в имя файла, поэтому проверяем его строго по белому
   списку символов. Без этой проверки через код вида "../../ETC/X" можно
   вырваться из папки с данными и прочитать или перезаписать чужой файл. */
const CODE_RE = /^[A-Z0-9-]{4,12}$/;
const validCode = (code) => CODE_RE.test(code) && !code.includes("..");
const clientPath = (code) => {
  if (!validCode(code)) throw new Error("bad code");
  return STORE_DIR + "/clients/" + code + ".json";
};

/* ---------- Шифрование данных клиентов ----------
   Файлы кабинетов содержат имя, телефон и почту. На диске держим их
   зашифрованными: если кто-то получит доступ к тому, без ключа это мусор.

   Ключ — переменная DATA_KEY (любая длинная строка). Из неё выводится
   ключ шифрования, поэтому саму строку менять нельзя: старые файлы
   перестанут читаться. Если DATA_KEY не задан, работаем без шифрования
   и предупреждаем в логах — чтобы запуск не падал молча. */
const crypto = require("crypto");
const DATA_KEY = process.env.DATA_KEY || "";
const encKey = DATA_KEY
  ? crypto.createHash("sha256").update(String(DATA_KEY)).digest()
  : null;

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  // формат: v1.вектор.тег.данные — версия нужна, чтобы позже сменить алгоритм
  return "v1." + iv.toString("base64") + "." + c.getAuthTag().toString("base64")
       + "." + enc.toString("base64");
}
function decrypt(raw) {
  const p = raw.split(".");
  if (p.length !== 4 || p[0] !== "v1") throw new Error("bad format");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(p[1], "base64"));
  d.setAuthTag(Buffer.from(p[2], "base64"));
  return Buffer.concat([d.update(Buffer.from(p[3], "base64")), d.final()]).toString("utf8");
}

function readClient(code) {
  if (!validCode(code)) return null;
  try {
    const raw = fs.readFileSync(clientPath(code), "utf8");
    // старые файлы лежат открытым текстом — читаем и их, чтобы не потерять клиентов
    if (raw.startsWith("v1.")) {
      if (!encKey) { console.error("Файл зашифрован, а DATA_KEY не задан"); return null; }
      return JSON.parse(decrypt(raw));
    }
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    console.error("read client failed");
    return null;
  }
}
/* The new content goes to a temporary file and replaces the cabinet in one
   step. Writing in place meant that a failed write (a full volume, a crash
   half-way) left an empty or half-written cabinet where a good one was. */
function writeClient(code, data) {
  if (!validCode(code)) return false;
  const destination = clientPath(code);
  const temporary = destination + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(temporary, encKey ? encrypt(json) : json, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    return true;
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch { /* nothing was written */ }
    console.error("write client failed");
    return false;
  }
}
/* Логи событий, лидов и заказов лежат РЯДОМ С КАБИНЕТАМИ, на томе.
   Раньше они писались в __dirname — то есть внутрь образа приложения,
   который Railway пересобирает при каждом деплое. Воронка в /api/stats
   обнулялась после каждой выкатки, а лиды и заказы оставались только в
   Telegram. Тот же STORE_DIR, что и у клиентов: если тома нет, оба
   набора данных временные, и предупреждение об этом уже есть. */
const EVENTS_LOG = STORE_DIR + "/events.log";
const LEADS_LOG = STORE_DIR + "/leads.log";
const ORDERS_LOG = STORE_DIR + "/orders.log";
const orderStore = createOrderStore({ dir: STORE_DIR, key: DATA_KEY });

/* Разовый перенос старых логов из образа на том. Без него после деплоя
   статистика начнётся с нуля, хотя данные за прошлый период существуют.
   Дописываем в конец, а исходник не удаляем: он всё равно исчезнет
   вместе с образом, а так перенос можно повторить, если что-то пойдёт
   не так. Пустые и отсутствующие файлы просто пропускаются. */
for (const [from, to] of [
  [__dirname + "/events.log", EVENTS_LOG],
  [__dirname + "/leads.log", LEADS_LOG],
  [__dirname + "/orders.log", ORDERS_LOG],
]) {
  if (from === to) continue;
  try {
    const old = fs.readFileSync(from, "utf8");
    if (old.trim()) {
      fs.appendFileSync(to, old.endsWith("\n") ? old : old + "\n");
      console.log("Перенёс на том: " + from + " → " + to);
    }
  } catch (e) { /* файла нет — это норма */ }
}

// Код доступа: без похожих символов, чтобы диктовать по телефону
function makeCode() {
  return makeAccessCode();   // secure generator, see request-guard.js
}


function createPortalClient(fields) {
  const name = String(fields.name || "").trim();
  const surname = String(fields.surname || "").trim();
  if (name.length < 2 || surname.length < 2) return { ok: false, error: "name" };

  let code = makeCode();
  for (let i = 0; i < 8 && readClient(code); i++) code = makeCode();
  if (readClient(code)) return { ok: false, error: "code" };

  const now = new Date().toISOString();
  const data = {
    code,
    name: name.slice(0, 60),
    surname: surname.slice(0, 60),
    phone: typeof fields.phone === "string" ? fields.phone.slice(0, 20) : "",
    email: typeof fields.email === "string" && validEmail(fields.email.trim()) ? fields.email.trim() : "",
    tgChatId: null,
    notify: { email: false, telegram: true },
    profile: fields.profile && typeof fields.profile === "object" ? fields.profile : {},
    intakeYear: Number.isInteger(fields.intakeYear) && fields.intakeYear > 2024 && fields.intakeYear < 2100
      ? fields.intakeYear : defaultIntakeYear(),
    done: {},
    createdAt: now,
    updatedAt: now,
  };
  if (fields.sourceOrderId) data.sourceOrderId = String(fields.sourceOrderId).slice(0, 32);
  if (!writeClient(code, data)) return { ok: false, error: "write" };
  return { ok: true, code, data };
}

function findClientByOrderId(orderId) {
  try {
    for (const file of fs.readdirSync(STORE_DIR + "/clients")) {
      if (!file.endsWith(".json")) continue;
      const client = readClient(file.replace(/\.json$/, ""));
      if (client && client.sourceOrderId === orderId) return client;
    }
  } catch {}
  return null;
}

// База знаний по документам DSU/ISU + промпт проверяющего
let CHECK_PROMPT = "";
try {
  const rules = fs.readFileSync(__dirname + "/knowledge/dsu-isu-rules.md", "utf8");
  CHECK_PROMPT = fs.readFileSync(__dirname + "/check-prompt.txt", "utf8").replace("{{RULES}}", rules);
  console.log("Документная база загружена: " + rules.length + " символов");
} catch (e) {
  console.warn("WARN: не найдена база знаний по документам — /api/check-document будет отключён");
}
/* Модель вынесена в переменную: раньше строка была зашита в двух местах,
   и при смене поколения её приходилось искать по коду. */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const API_KEY = normalizeApiKey(process.env.ANTHROPIC_API_KEY);
const AI_WORKSPACE_ID = normalizeApiKey(process.env.ANTHROPIC_WORKSPACE_ID);
const AI_HEADERS = anthropicHeaders(API_KEY, AI_WORKSPACE_ID);
if (!API_KEY) console.warn("WARN: ANTHROPIC_API_KEY не задан — чат не будет работать");
const aiReadiness = createAiReadiness({ apiKey: API_KEY, model: MODEL, workspaceId: AI_WORKSPACE_ID,
  request: (url, options) => fetchWithTimeout(url, options, 8000),
  onChange: state => console.log("AI readiness: " + JSON.stringify(state)),
});

/* --- Rate limit: отдельная корзина на каждый вид запроса ---

   Раньше счётчик был один на всё: 20 запросов / 5 минут с IP на чат,
   проверку документов и кабинет вместе. Человек, поговоривший с ботом,
   после этого не мог открыть свой кабинет. А за NAT — школьный или
   операторский — несколько студентов съедали лимит друг у друга.

   Теперь у каждого эндпоинта своя корзина и свой предел, исходя из
   того, сколько запросов там нужно живому человеку:
   чат — диалог, событий аналитики много и они дешёвые, проверка
   документа дорогая, а вход в кабинет должен быть жёстким отдельно
   (см. loginLimit ниже) — там перебирают чужие коды.

   Счётчики в памяти процесса: при рестарте сбрасываются и на втором
   инстансе не общие. Для текущего одного инстанса этого достаточно;
   если появится второй — сюда нужен Redis, а не ещё одна Map. */
const WINDOW_MS = 5 * 60 * 1000;
/* Security pass, 27 Nov. On the live site these limits never triggered:
   the key was the Netlify node, not the visitor (request-guard.js has the
   measurement). Now every limit counts the visitor's own address and, with a
   ceiling ten times higher, the machine that connected to us.

   The numbers were raised at the same time. They had never been enforced, and
   a phone on a mobile network shares its address with other subscribers:
   limits sized for one person would have stopped real visitors on the first
   busy day of the ads. One address still cannot run up the bill, and the
   total is capped separately (aiSpend below). */
const PEER_FACTOR = 10;
const sweepable = [];

function clientIp(req) {
  return requestIdentity(req).client;
}

function makeLimit(name, max, windowMs = WINDOW_MS, message) {
  const limit = createDualLimit({ max, windowMs, peerFactor: PEER_FACTOR });
  sweepable.push(limit);
  return function limitRequest(req, res, next) {
    const result = limit.hit(requestIdentity(req));
    if (result.over) {
      res.set("Retry-After", String(result.retryAfter));
      // чат ждёт поле reply, остальные — error; отдаём оба, чтобы
      // любой клиент показал человеку текст, а не «ошибка сервера»
      const text = message || "Слишком много запросов. Подожди пару минут и попробуй снова.";
      return res.status(429).json({ ok: false, reply: text, error: text });
    }
    next();
  };
}

const rateLimit = makeLimit("chat", 60);
const heavyLimit = makeLimit("document", 20, WINDOW_MS,
  "Проверка документов ограничена: слишком много файлов за 5 минут. Подожди немного.");
const portalLimit = makeLimit("portal", 120);
const eventLimit = makeLimit("event", 600, WINDOW_MS, "Слишком много событий.");
const orderLimit = makeLimit("order", 20, WINDOW_MS,
  "Слишком много заявок подряд. Подожди пару минут.");
/* The page after payment asks for the order up to 25 times in half a minute
   (PaymentSuccess on the site). It shared the 10-per-5-minutes order limit,
   and only the broken limiter kept a buyer from being cut off before the
   access code arrived. Its own limit: a few payments from one address. */
const orderStatusLimit = makeLimit("order-status", 150, WINDOW_MS,
  "Слишком много запросов. Подожди минуту и обнови страницу.");
// «Не помню код»: живому человеку хватает одной-двух попыток.
const recoverLimit = makeLimit("recover", 8, WINDOW_MS,
  "Слишком много запросов кода подряд. Подожди пару минут.");

/* Вход в кабинет — отдельно и строже. Считаем ТОЛЬКО неудачные попытки:
   человек, который спокойно работает в своём кабинете, этого лимита не
   видит вообще. С 27 ноября счётчик один на все адреса кабинета (раньше
   его вели только при входе, а сохранение шага, документа, настроек и
   удаление принимали сколько угодно неверных попыток), и считает он и
   посетителя, и подключившуюся машину. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILS = 12;
const loginFails = createDualLimit({ max: LOGIN_MAX_FAILS, windowMs: LOGIN_WINDOW_MS, peerFactor: PEER_FACTOR });
sweepable.push(loginFails);
/* Подбор с многих адресов сразу ни один адрес не блокирует. Владелец узнаёт
   о нём по общему числу неудач: одно сообщение в час, без кодов и имён. */
const LOGIN_ALARM = 150;
const loginFailsTotal = createWindowCounter(LOGIN_WINDOW_MS);
sweepable.push(loginFailsTotal);
let loginAlarmAt = 0;

function loginBlocked(req) {
  return loginFails.blocked(requestIdentity(req));
}
function noteLoginFail(req) {
  loginFails.hit(requestIdentity(req));
  if (loginFailsTotal.hit("all").count === LOGIN_ALARM && Date.now() - loginAlarmAt > 3600e3) {
    loginAlarmAt = Date.now();
    ownerAlert("⚠️ IITALY: " + LOGIN_ALARM + " неудачных входов в кабинеты за 15 минут. Похоже на подбор кодов. "
      + "Адреса, с которых идёт перебор, блокируются сами; коды и фамилии не раскрыты.");
  }
}

/* Ключ владельца (STATS_KEY). Сравнение без утечки по времени, и неверные
   попытки считаются: ключ нельзя подбирать перебором. */
const adminFails = createDualLimit({ max: 8, windowMs: LOGIN_WINDOW_MS, peerFactor: 3 });
sweepable.push(adminFails);
function adminAllowed(req, legacyKey) {
  const who = requestIdentity(req);
  if (adminFails.blocked(who)) return false;
  const auth = String((req.headers && req.headers.authorization) || "");
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : String(legacyKey || "");
  if (safeEqual(supplied, String(process.env.STATS_KEY || ""))) return true;
  adminFails.hit(who);
  return false;
}

/* Сообщение владельцу о событии безопасности. Не чаще, чем его вызывают:
   каждый вызывающий сам следит, чтобы писать один раз. */
function ownerAlert(text) {
  Promise.resolve(tgSendTo(process.env.TG_CHAT_ID, text)).catch(() => {});
}

/* Потолок платных обращений к ИИ на всех вместе. Лимит по адресу держит
   один адрес; если нагрузку размазать по многим адресам, счёт у провайдера
   всё равно рос бы без предела. Пределы задаются переменными, значения по
   умолчанию — с запасом на рекламный день (см. .env.example). */
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
const aiBudgets = {
  chat: createBudget({ hourly: envNumber("AI_CHAT_PER_HOUR", 500), daily: envNumber("AI_CHAT_PER_DAY", 4000) }),
  document: createBudget({ hourly: envNumber("AI_DOCS_PER_HOUR", 150), daily: envNumber("AI_DOCS_PER_DAY", 1000) }),
};
const AI_BUSY = "Сейчас слишком много запросов к помощнику. Попробуй через несколько минут.";
function aiSpend(kind) {
  const budget = aiBudgets[kind], taken = budget.take();
  const label = kind === "chat" ? "вопросов помощнику" : "проверок документов";
  const names = kind === "chat" ? "AI_CHAT_PER_HOUR / AI_CHAT_PER_DAY" : "AI_DOCS_PER_HOUR / AI_DOCS_PER_DAY";
  if (!taken.ok && taken.first) {
    ownerAlert("⚠️ IITALY: достигнут предел " + label + " за "
      + (taken.window === "hour" ? "час (" + budget.hourly + ")" : "сутки (" + budget.daily + ")")
      + ". Новые запросы получают «попробуй позже», пока окно не обновится. "
      + "Если это живые посетители, подними предел на Railway: " + names + ".");
  } else if (taken.ok && taken.nearly) {
    ownerAlert("ℹ️ IITALY: израсходовано 80% суточного предела " + label + " (" + taken.used + " из " + budget.daily + ").");
  }
  return taken.ok;
}

/* Запрос с ограничением по времени: если внешний сервис не отвечает,
   соединение обрывается, а не копится до исчерпания памяти. */
async function fetchWithTimeout(url, opts, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } finally {
    clearTimeout(t);
  }
}

/* Все ссылки в сообщениях и возврат после оплаты ведут на iitaly.net.
   Владелец, 24 ноября, скриншот бота: «Открыть кабинет:
   https://iitaly.netlify.app/portal» и под ней превью со старой ценой 667 ₸.
   SITE_URL на Railway мог остаться старым адресом Netlify — такой адрес
   не используем, берём основной домен. */
function publicSiteUrl() {
  try {
    const u = new URL(process.env.SITE_URL || "");
    if (u.protocol === "https:" && !/(^|\.)netlify\.app$/i.test(u.hostname) && u.hostname !== "iitaly.kz") return u.origin;
  } catch { /* пустой или кривой SITE_URL — берём основной домен */ }
  return "https://iitaly.net";
}
const PUBLIC_SITE = publicSiteUrl();
const PORTAL_URL = PUBLIC_SITE + "/portal";

// Периодическая очистка корзин, чтобы не текла память
setInterval(() => {
  for (const counter of sweepable) counter.sweep();
}, WINDOW_MS);

// --- Health check для Railway/Render ---
app.get("/health", (_req, res) => {
  let storageReady = false;
  try {
    fs.accessSync(STORE_DIR, fs.constants.R_OK | fs.constants.W_OK);
    fs.accessSync(STORE_DIR + "/clients", fs.constants.R_OK | fs.constants.W_OK);
    storageReady = STORE_DIR === DATA_DIR;
  } catch {}
  const ok = storageReady;
  res.status(ok ? 200 : 503).json({
    ok,
    storage: storageReady ? "ready" : "unavailable",
    telegramConfigured: Boolean(process.env.TG_BOT_TOKEN && process.env.TG_WEBHOOK_SECRET),
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET),
    remindersEnabled: process.env.REMINDERS !== "off",
    ai: aiReadiness.snapshot(),
  });
});

/* The address the limits count for the caller — their own, nothing else.
   It is how the 27 Nov limiter fix was measured and how it can be re-checked
   from any device: through the site this must be the device's address, not
   a Netlify node. */
app.get("/health/ip", (req, res) => {
  const who = requestIdentity(req);
  res.json({ ok: true, ip: who.client, proxied: who.client !== who.peer });
});

// Separate readiness: invalid AI credentials must not restart payments/portal.
app.get("/health/ai", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const state = await aiReadiness.check();
  if (!CHECK_PROMPT) return res.status(503).json({ ok: false, code: "AI_KNOWLEDGE_MISSING", retryable: false,
    error: "Проверка документов отключена до восстановления базы знаний. Гайды доступны без ИИ." });
  res.status(state.ok ? 200 : 503).json(state);
});

/* Бот глазами самого Telegram (владелец, 24 ноября: «насколько реально
   работает Telegram»). Отправлять сообщения сервер умеет и без вебхука, а
   принимать /start, /help и подключение кабинета — только если вебхук
   зарегистрирован в Telegram (scripts/tg-setup.js) и указывает сюда. Здесь
   видно: какой бот на токене, совпадает ли он с TG_BOT_NAME из ссылки
   кабинета, есть ли вебхук, сколько апдейтов ждёт и последняя ошибка
   доставки. Только чтение; токен, секрет и полный URL наружу не уходят;
   ответ кешируется на минуту, чтобы не упираться в лимиты Telegram. */
let tgHealthCache = { at: 0, status: 200, body: null };
app.get("/health/telegram", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const token = process.env.TG_BOT_TOKEN;
  if (!token) return res.status(503).json({ ok: false, configured: false });
  if (tgHealthCache.body && Date.now() - tgHealthCache.at < 60000) {
    return res.status(tgHealthCache.status).json(tgHealthCache.body);
  }
  const ask = async (method) => {
    const r = await fetchWithTimeout("https://api.telegram.org/bot" + token + "/" + method, {}, 8000);
    return r.json();
  };
  let status = 200, body;
  try {
    const [me, hook] = await Promise.all([ask("getMe"), ask("getWebhookInfo")]);
    const info = (hook && hook.ok && hook.result) || {};
    let host = "", pathname = "";
    try { const u = new URL(info.url); host = u.host; pathname = u.pathname; } catch {}
    const bot = me && me.ok && me.result ? me.result.username : null;
    const linkBot = String(process.env.TG_BOT_NAME || "").replace(/^@/, "").trim() || null;
    const webhook = {
      set: Boolean(info.url),
      host,
      pathOk: pathname.endsWith("/api/tg/webhook"),
      pending: Number(info.pending_update_count) || 0,
      lastError: info.last_error_message || null,
      lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
    };
    const linkBotMatches = Boolean(bot && linkBot && bot.toLowerCase() === linkBot.toLowerCase());
    body = { ok: Boolean(bot && linkBotMatches && webhook.set && webhook.pathOk), bot, linkBot, linkBotMatches, webhook };
  } catch (e) {
    status = 502;
    body = { ok: false, error: "Telegram не ответил" };
  }
  tgHealthCache = { at: Date.now(), status, body };
  res.status(status).json(body);
});

// --- Основной эндпоинт чата ---
const CHAT_MAX_CHARS = 60000;
app.post("/api/chat", rateLimit, async (req, res) => {
  try {
    const { messages, profile } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
      return res.status(400).json({ reply: "Некорректный запрос." });
    }
    // Профиль из онбординга: только известные поля, обрезанные по длине
    let profileNote = "";
    if (profile && typeof profile === "object") {
      const clean = (v) => (typeof v === "string" ? v.slice(0, 40) : "");
      const e = clean(profile.education), g = clean(profile.goal), b = clean(profile.budget);
      if (e || g || b) {
        profileNote = `\n\nПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (учитывай в ответах): образование: ${e || "?"}; цель: ${g || "?"}; бюджет: ${b || "?"}.`;
      }
    }
    /* Валидация каждого сообщения: роль и длина.

       Лимит 8000, а не прежние 4000. С октября 2026 сайт приклеивает к
       первому сообщению проверенную справку о поступлении (~3 700 символов,
       src/data/admissionsContext.ts во фронтенде) и пересылает её с каждым
       ходом. При 4000 на сам вопрос оставалось ~280 символов: развёрнутый
       вопрос родителя отбивался, и человек видел «Некорректный запрос.» —
       ответ, из которого не понять, что не так. 8000 оставляют вопросу
       прежние 4000 и дают справке запас на рост.

       Длину проверяем отдельно от формы и отвечаем по-человечески: длинное
       сообщение — единственная из этих ошибок, которую человек может
       исправить сам. */
    let totalLength = 0;
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
        return res.status(400).json({ reply: "Некорректный запрос." });
      }
      if (m.content.length > 8000) {
        return res.status(400).json({ reply: "Сообщение слишком длинное. Сократи вопрос или раздели его на несколько." });
      }
      totalLength += m.content.length;
    }
    /* Whole dialogue, not only each message: 40 messages of 8000 characters
       passed the checks above, and every such request was paid for in full.
       A real dialogue with the site's reference text stays well under this. */
    if (totalLength > CHAT_MAX_CHARS) {
      return res.status(400).json({ reply: "Диалог стал слишком длинным. Начни новый разговор." });
    }

    const readiness = await aiReadiness.check();
    if (!readiness.ok) return res.status(503).json({ ...readiness, reply: readiness.error });
    if (!aiSpend("chat")) return res.status(503).json({ ok: false, code: "AI_BUSY", retryable: true, reply: AI_BUSY, error: AI_BUSY });
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AI_HEADERS,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT + profileNote,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!r.ok) {
      console.error("Anthropic API error:", r.status);
      const failure = aiReadiness.recordFailure(r.status);
      if (failure) return res.status(503).json({ ...failure, reply: failure.error });
      return res.status(502).json({ reply: "Сервис временно недоступен. Попробуй через минуту." });
    }

    const data = await r.json();
    const reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "Не удалось получить ответ.";
    res.json({ reply });
  } catch (e) {
    console.error("server error:", e.message);
    res.status(500).json({ reply: "Внутренняя ошибка сервера." });
  }
});





// --- Проверка документа по базе знаний DSU/ISU ---
// Принимает { image: "data:image/jpeg;base64,...", mediaType, hint } или { text }
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_B64 = 7_500_000;   // ~5.6 МБ файла — предел Anthropic API

/* Потолок ответа проверки. Был 1500 — на глаз впритык: типовой разбор
   (пять проверок, две проблемы, три шага) по-русски занимает около 600
   токенов, но кириллица в токенизаторе дороже латиницы, а на сложном
   документе модели разрешено семь проверок вместо пяти, и запас в
   2.5 раза съедается быстро. Обрезанный ответ не разбирается ничем:
   JSON.parse падает, а запасной поиск /\{[\s\S]*\}/ требует закрывающей
   скобки, которой у обрезанного ответа нет. Платим только за
   сгенерированное, поэтому запас ничего не стоит, а обрыв стоит всей
   проверки. */
const ANSWER_TOKENS = 4000;

/* Почему Anthropic отказал — словами, по которым понятно, что делать.

   Раньше на любой не-2xx ответ человек видел «Сервис проверки временно
   недоступен. Попробуй через минуту.» Это верно только для перегрузки и
   лимитов. Кончился баланс, отозван ключ, в ANTHROPIC_MODEL опечатка —
   ждать бесполезно, а сообщение обещало, что через минуту заработает, и
   по скриншоту было не понять, какая из бед случилась.

   Код в скобках нужен владельцу сайта, а не посетителю: по скриншоту
   сразу видно, куда идти — в биллинг, в ключи или в переменные Railway.
   Текст ошибки Anthropic наружу не отдаём, он остаётся в логе. */
function checkFailure(status, bodyText) {
  let type = "", message = "";
  try {
    const parsed = JSON.parse(bodyText);
    type = (parsed && parsed.error && parsed.error.type) || "";
    message = (parsed && parsed.error && parsed.error.message) || "";
  } catch {}

  if (status === 429 || status === 500 || status === 529 || type === "overloaded_error" || type === "api_error" || type === "rate_limit_error") {
    return "Сервис проверки перегружен. Попробуй через минуту.";
  }
  if (status === 413 || type === "request_too_large") {
    return "Файл слишком большой для проверки. Пришли страницы по отдельности.";
  }
  const ours = "Проверка документов сейчас не работает по нашей вине. Попробуй позже или задай вопрос в чате.";
  if (status === 402 || type === "billing_error" || /credit balance/i.test(message)) return ours + " (код: баланс API)";
  if (status === 401 || type === "authentication_error") return ours + " (код: ключ API)";
  if (status === 403 || type === "permission_error") return ours + " (код: доступ API)";
  if (status === 404 || type === "not_found_error") return ours + " (код: модель " + MODEL + ")";
  if (/image|media.?type|pdf|document/i.test(message)) {
    return "Не получилось прочитать файл. Пришли PDF или фото в JPG или PNG.";
  }
  return ours + " (код " + status + ")";
}

app.post("/api/check-document", heavyLimit, async (req, res) => {
  try {
    if (!CHECK_PROMPT) return res.status(503).json({ ok: false, error: "Проверка документов временно недоступна." });
    const { image, pdf, mediaType, hint, text, fileName, context } = req.body || {};
    const review = buildDocumentReviewContext(context);
    const hintText = "Проверь этот документ."
      + (typeof fileName === "string" && fileName ? " Имя файла: " + fileName.slice(0, 80) + "." : "")
      + (typeof hint === "string" && hint ? " Пользователь считает, что это: " + hint.slice(0, 100) : "");

    let content;

    // 1. PDF — Claude читает его напрямую, включая многостраничные
    if (typeof pdf === "string" && pdf.length > 100) {
      const b64 = pdf.includes(",") ? pdf.split(",").pop() : pdf;
      if (b64.length > MAX_B64) {
        return res.status(413).json({ ok: false, error: "PDF слишком большой. Раздели его на части или пришли только нужные страницы." });
      }
      content = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: hintText },
      ];

    // 2. Фото документа
    } else if (typeof image === "string" && image.length > 100) {
      const b64 = image.includes(",") ? image.split(",").pop() : image;
      if (b64.length > MAX_B64) {
        return res.status(413).json({ ok: false, error: "Файл слишком большой. Сожми фото или сними при меньшем разрешении." });
      }
      const mt = ALLOWED_MEDIA.includes(mediaType) ? mediaType : "image/jpeg";
      content = [
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
        { type: "text", text: hintText },
      ];

    // 3. Текст: Word и другие форматы браузер превращает в текст перед отправкой
    } else if (typeof text === "string" && text.trim().length > 20) {
      content = [{ type: "text", text: hintText + "\n\nТекстовое содержимое документа:\n\n" + text.slice(0, 40000) }];

    } else {
      return res.status(400).json({ ok: false, error: "Пришли фото, PDF или файл документа." });
    }

    const readiness = await aiReadiness.check();
    if (!readiness.ok) return res.status(503).json(readiness);
    if (!aiSpend("document")) return res.status(503).json({ ok: false, code: "AI_BUSY", retryable: true, error: AI_BUSY });
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...AI_HEADERS,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: ANSWER_TOKENS,
        system: CHECK_PROMPT + documentContextPrompt(review),
        messages: [{ role: "user", content }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("Anthropic error (check-document):", r.status);
      const failure = aiReadiness.recordFailure(r.status);
      if (failure) return res.status(503).json(failure);
      return res.status(502).json({ ok: false, error: checkFailure(r.status, errText) });
    }

    const data = await r.json();
    const blocks = Array.isArray(data.content) ? data.content : [];
    const raw = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      /* Диагностика формы ответа — БЕЗ единого символа самого ответа.
         Раньше здесь была одна строка «не удалось разобрать ответ
         модели», и по ней нельзя было отличить обрезанный ответ от
         отказа модели и от пустого content: три разные беды выглядели
         одинаково, и починить их было нечем.

         Содержимое не логируем сознательно. Текст модели пересказывает
         документ человека — там фамилия, суммы, номер счёта. Сайт обещает
         «не публикуем и не продаём», и писать это в логи хостинга значит
         нарушить обещание ради удобства отладки. Формы хватает: причина
         читается по stop_reason, длине и наличию скобок. */
      console.error("check-document: ответ модели не разобран " + JSON.stringify({
        stop_reason: data.stop_reason || "?",
        output_tokens: (data.usage && data.usage.output_tokens) || 0,
        max_tokens: ANSWER_TOKENS,
        blocks: blocks.map((b) => b.type).join("|") || "нет",
        len: cleaned.length,
        open: cleaned.includes("{"),
        close: cleaned.trimEnd().endsWith("}"),
      }));

      /* Причины разные — и человеку про них надо говорить по-разному.
         Общее «не удалось разобрать» не подсказывает ни одного действия. */
      if (data.stop_reason === "max_tokens") {
        return res.status(502).json({ ok: false,
          error: "Разбор документа не поместился в ответ. Пришли страницы по отдельности." });
      }
      if (data.stop_reason === "refusal") {
        return res.status(502).json({ ok: false,
          error: "Проверка отклонила этот файл. Попробуй другой документ или спроси в чате." });
      }
      if (!cleaned.length) {
        return res.status(502).json({ ok: false,
          error: "Сервис проверки вернул пустой ответ. Попробуй ещё раз через минуту." });
      }
      return res.status(502).json({ ok: false, error: "Не удалось разобрать результат проверки. Попробуй ещё раз." });
    }
    res.json({ ok: true, result: normalizeDocumentResult(parsed, review) });
  } catch (e) {
    console.error("check-document error:", e.message);
    res.status(500).json({ ok: false, error: "Внутренняя ошибка сервера." });
  }
});

/* ================= ЛИЧНЫЙ КАБИНЕТ ================= */

// Выдать доступ клиенту после оплаты. Только для владельца: нужен STATS_KEY.
app.post("/api/portal/create", async (req, res) => {
  try {
    if (!adminAllowed(req, (req.body || {}).key)) return res.status(403).json({ ok: false, error: "forbidden" });
    const created = createPortalClient(req.body || {});
    if (!created.ok) {
      const status = created.error === "name" ? 400 : 500;
      return res.status(status).json({ ok: false, error: created.error === "name" ? "Укажи имя и фамилию" : "Не удалось создать кабинет" });
    }
    console.log("PORTAL CREATED");
    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (token && chat) {
      fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: "🔑 Кабинет создан\n" + created.data.surname + " " + created.data.name + "\nКод: " + created.code }),
      }).catch(() => {});
    }
    res.json({ ok: true, code: created.code });
  } catch {
    console.error("portal create error");
    res.status(500).json({ ok: false, error: "Внутренняя ошибка" });
  }
});

// Состояние кабинета по коду доступа
// Нормализация фамилии: регистр, пробелы, е/ё — чтобы вход не зависел от мелочей
function normSurname(v) {
  return String(v || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

/* Чтение кабинета. Один обработчик на два адреса:

   POST /api/portal/lookup  — основной. Код и фамилия идут в теле.
   GET  /api/portal/:code?surname=  — старый, оставлен рабочим.

   Зачем добавлен POST: в GET код доступа лежит в пути, а фамилия в
   query-строке, и оба оседают в журналах Railway, CDN и любого прокси
   по дороге — то есть учётные данные кабинета пишутся открытым текстом
   в логи, которые мы не контролируем. В теле POST этого не происходит.
   Старый GET не удалён намеренно: фронтенд и бэкенд выкатываются
   порознь, и на время рассинхрона сайт должен продолжать работать. */
function portalPayload(c) {
  const roadmap = buildRoadmap(null, c.profile, c.intakeYear);
  let total = 0, done = 0;
  for (const st of roadmap) for (const t of st.tasks) { total++; if (c.done[t.id]) done++; }

  const p = c.profile || {};
  const onboardingComplete = Boolean(
    p.onboardingDone &&
    profileReady(p) &&
    (!needsTwelveYears(p) || p.educationPath)
  );

  return {
    ok: true,
    client: {
      name: c.name,
      surname: c.surname,
      intakeYear: c.intakeYear,
      createdAt: c.createdAt,
      email: c.email || "",
      tgLinked: !!c.tgChatId,
      notify: c.notify || { email: true, telegram: true },
      botName: process.env.TG_BOT_NAME || "",
      profile: p,
      onboardingComplete,
    },
    roadmap,
    done: c.done,
    docs: c.docs || {},
    progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
  };
}

/* One door for every cabinet address (security pass, 27 Nov).

   Before, only the login counted wrong attempts. Saving a step, a document,
   the settings, the Telegram link and deletion checked the code and the
   surname themselves, did not count failures, and answered 404 for an
   unknown code but 403 for a wrong surname. That told a stranger which
   codes exist, and let them try surnames against a found code without end.

   Now: the same answer whether the code or the surname is wrong, every
   failure counts toward the same lock, and a locked address gets 429 before
   the cabinet is even read. Returns the cabinet or null (answer already sent). */
const PORTAL_DENIED = "Не нашли бронь. Проверь фамилию и код.";
function portalAuth(req, res, rawCode, surname) {
  if (loginBlocked(req)) {
    res.status(429).json({ ok: false, error: "Слишком много попыток входа. Попробуй через 15 минут." });
    return null;
  }
  const code = String(rawCode || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  const expected = c ? normSurname(c.surname) : "";
  const supplied = normSurname(surname);
  // A cabinet saved without a surname (old records) opens as before, by an empty one.
  const match = Boolean(c) && (expected ? safeEqual(supplied, expected) : supplied === "");
  if (!match) {
    noteLoginFail(req);
    res.status(404).json({ ok: false, error: PORTAL_DENIED });
    return null;
  }
  return c;
}

/* The old GET /api/portal/:code?surname= is gone: it put the code and the
   surname into the address, and addresses are written to logs on the way.
   The site has used POST /api/portal/lookup since it appeared. */
app.post("/api/portal/lookup", portalLimit, (req, res) => {
  const body = req.body || {};
  const c = portalAuth(req, res, body.code, body.surname);
  if (c) res.json(portalPayload(c));
});

/* «Не помню код» — подробности и правила в portal-recovery.js.
   Ответ одинаковый для всех, код уходит только в Telegram и на почту
   самого клиента, отправка — после ответа. */
const recoveryCooldown = createRecoveryCooldown();
const RECOVERY_SITE_URL = PUBLIC_SITE;

app.post("/api/portal/recover", recoverLimit, (req, res) => {
  const body = req.body || {};
  const surname = String(body.surname || "").slice(0, 60);
  const phone = String(body.phone || "").slice(0, 20);
  if (normSurname(surname).length < 2 || !phoneKey(phone)) {
    return res.status(400).json({ ok: false, error: "Укажи фамилию и телефон, как при оплате." });
  }
  res.json({ ok: true });
  const matches = findRecoveryMatches({ surname, phone }, {
    listCodes: () => listClients().map(file => file.replace(/\.json$/, "")),
    readClient,
    normSurname,
  });
  if (!matches.length) return;
  deliverRecovery(matches, {
    cooldown: recoveryCooldown,
    siteUrl: RECOVERY_SITE_URL,
    sendTelegram: (chatId, text) => tgSendTo(chatId, text),
    sendEmail: (to, subject, text) => sendMail(to, subject, text),
    alertOwner: text => tgSendTo(process.env.TG_CHAT_ID, text),
  }).then(results => {
    for (const r of results) {
      console.log("PORTAL RECOVERY: " + (r.skipped ? "cooldown" : r.sent.length ? r.sent.join("+") : r.ownerAlerted ? "owner" : "nowhere"));
    }
  }).catch(() => console.error("portal recovery error"));
});

const PROFILE_VALUES = {
  education: new Set(["11 классов", "НИШ / 12 лет", "Студент вуза КЗ", "Бакалавр"]),
  goal: new Set(["Бакалавриат", "Магистратура"]),
  budget: new Set(["Только со стипендией", "До 1 млн ₸/год", "До 3 млн ₸/год", "Без ограничений"]),
  educationPath: new Set(["university_kz", "foundation"]),
};

// Первый вход в кабинет сохраняет только данные, которые реально меняют маршрут.
// Профиль и развилка 12 лет закрываются автоматически — пользователь не ставит
// галочку там, где система сама знает состояние.
app.post("/api/portal/:code/profile", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);

  const body = req.body || {};
  const p = c.profile = c.profile || {};

  // Catalogue IDs only. Store them with the authenticated, encrypted profile;
  // changing a shortlist must not replace unrelated answers or documents.
  if (body.universityIds !== undefined) {
    if (!Array.isArray(body.universityIds) || body.universityIds.length > 43 ||
        body.universityIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) {
      return res.status(400).json({ ok: false, error: "Проверь список университетов" });
    }
    p.universityIds = [...new Set(body.universityIds)];
  }

  for (const key of ["education", "goal", "budget"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !PROFILE_VALUES[key].has(body[key])) {
        return res.status(400).json({ ok: false, error: "Проверь ответы профиля" });
      }
      p[key] = body[key];
    }
  }

  if (body.educationPath !== undefined) {
    if (body.educationPath !== null &&
        (typeof body.educationPath !== "string" || !PROFILE_VALUES.educationPath.has(body.educationPath))) {
      return res.status(400).json({ ok: false, error: "Проверь путь 12 лет образования" });
    }
    if (body.educationPath) p.educationPath = body.educationPath;
    else delete p.educationPath;
  }

  if (typeof body.onboardingDone === "boolean") p.onboardingDone = body.onboardingDone;

  // Если человек уже учится в вузе Казахстана, путь 12-го года уже выбран
  // фактом обучения — не заставляем отвечать на тот же вопрос второй раз.
  if (p.education === "Студент вуза КЗ") p.educationPath = "university_kz";

  c.done = c.done || {};
  const now = new Date().toISOString();
  if (profileReady(p)) c.done.profile = c.done.profile || now;
  else delete c.done.profile;

  if (!needsTwelveYears(p)) {
    c.done.path12 = c.done.path12 || now;
    delete p.educationPath;
  } else if (p.educationPath) {
    c.done.path12 = c.done.path12 || now;
  } else {
    delete c.done.path12;
  }

  c.updatedAt = now;
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось сохранить профиль" });
  res.json(portalPayload(c));
});

// Отметить задачу выполненной или снять отметку
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TASK_KEYS = 200;
app.post("/api/portal/:code/task", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);

  const { task, value } = req.body || {};
  if (typeof task !== "string" || !/^[a-zA-Z0-9_]{2,30}$/.test(task) || RESERVED_KEYS.has(task)) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
  }
  c.done = c.done || {};
  // The plan has a few dozen steps; marks beyond that are not the plan.
  if (value && !c.done[task] && Object.keys(c.done).length >= MAX_TASK_KEYS) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
  }
  if (task === "profile" || task === "path12") {
    return res.status(409).json({ ok: false, error: "Этот шаг обновляется автоматически из профиля." });
  }
  if (value) c.done[task] = new Date().toISOString(); else delete c.done[task];
  c.updatedAt = new Date().toISOString();
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось сохранить" });

  const roadmap = buildRoadmap(null, c.profile, c.intakeYear);
  let total = 0, done = 0;
  for (const st of roadmap) for (const t of st.tasks) { total++; if (c.done[t.id]) done++; }
  res.json({ ok: true, done: c.done, progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 } });
});





/* Проверка документа, привязанная к задаче маршрута.
   Сохраняем ограниченный текстовый отчёт с основаниями и действиями.
   Исходные файлы, изображения/base64 и произвольные поля не сохраняются. */
app.post("/api/portal/:code/doc", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const { task, result, fileName } = req.body || {};
  if (typeof task !== "string" || !/^[a-zA-Z0-9_]{2,30}$/.test(task) || RESERVED_KEYS.has(task)) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
  }
  if (!(c.docs && c.docs[task]) && Object.keys(c.docs || {}).length >= MAX_TASK_KEYS) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
  }
  const storedResult = sanitizePortalDocumentResult(result);
  if (!storedResult) {
    return res.status(400).json({ ok: false, error: "Нет результата проверки" });
  }

  const { verdict } = storedResult;
  const problems = storedResult.problems.length;
  const critical = storedResult.problems.filter((p) => p.severity === "critical").length;

  c.docs = c.docs || {};
  const prev = c.docs[task];
  c.docs[task] = {
    verdict,
    docTitle: storedResult.docTitle.slice(0, 80),
    summary: storedResult.summary.slice(0, 400),
    problems, critical,
    result: storedResult,
    fileName: typeof fileName === "string" ? fileName.slice(0, 80) : "",
    checkedAt: new Date().toISOString(),
    attempts: (prev && prev.attempts ? prev.attempts : 0) + 1,
  };

  // A replacement report supersedes the previous result, including its completion.
  c.done = c.done || {};
  if (verdict === "ok") c.done[task] = new Date().toISOString();
  else delete c.done[task];

  c.updatedAt = new Date().toISOString();
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось сохранить" });

  const roadmap = buildRoadmap(null, c.profile, c.intakeYear);
  let total = 0, done = 0;
  for (const st of roadmap) for (const t of st.tasks) { total++; if (c.done[t.id]) done++; }
  res.json({ ok: true, docs: c.docs, done: c.done,
    progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 } });
});


/* Удаление данных по запросу. В политике конфиденциальности мы это обещаем,
   значит должен быть работающий способ, а не переписка вручную. */
app.post("/api/portal/:code/delete", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  if (req.body.confirm !== "УДАЛИТЬ") {
    return res.status(400).json({ ok: false, error: "Нужно подтверждение" });
  }
  try {
    fs.unlinkSync(clientPath(code));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Не удалось удалить" });
  }
  console.log("PORTAL DELETED");
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (token && chat) {
    fetchWithTimeout("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "\u{1F5D1} Клиент удалил свои данные: " + code }),
    }, 15000).catch(() => {});
  }
  res.json({ ok: true });
});

// Клиент управляет напоминаниями из кабинета
app.post("/api/portal/:code/notify", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const { email, notifyEmail, notifyTelegram } = req.body || {};
  if (typeof email === "string") {
    // One address, nothing that a mail server could read as a second recipient.
    if (email.trim() && !validEmail(email.trim())) return res.status(400).json({ ok: false, error: "Проверь адрес почты" });
    c.email = email.trim();
  }
  c.notify = c.notify || {};
  if (typeof notifyEmail === "boolean") c.notify.email = notifyEmail;
  if (typeof notifyTelegram === "boolean") {
    c.notify.telegram = notifyTelegram;
    if (!notifyTelegram) {
      c.tgChatId = null;
      delete c.tgLink;
    }
  }
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось сохранить" });
  res.json({ ok: true, email: c.email || "", tgLinked: !!c.tgChatId, notify: c.notify });
});

/* ---------- Безопасная одноразовая ссылка Telegram ----------
   Код кабинета — часть учётных данных и не должен попадать в t.me URL.
   Кабинет выдаёт случайный токен на 15 минут; на диске хранится только
   SHA-256 хеш. После успешного /start запись удаляется и повторно не работает. */
app.post("/api/portal/:code/telegram-link", portalLimit, (req, res) => {
  const c = portalAuth(req, res, req.params.code, req.body && req.body.surname);
  if (!c) return;
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);

  const botName = String(process.env.TG_BOT_NAME || "").replace(/^@/, "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botName)) {
    return res.status(503).json({ ok: false, error: "Telegram-бот временно недоступен" });
  }

  const link = makeLinkToken();
  c.tgLink = link.record;
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось создать ссылку" });

  res.json({
    ok: true,
    url: "https://t.me/" + botName + "?start=" + encodeURIComponent(link.token),
    expiresAt: link.record.expiresAt,
  });
});

/* ---------- Подписка клиента на бота ----------
   Telegram получает только случайный одноразовый токен, а не код кабинета.
   23 Nov (owner: «проверь в целом телеграм»): the bot answered only /start
   and /stop, and anything else a person wrote to it got silence. Now /help,
   a plain /start and any other message in a private chat get a short answer:
   what the bot sends, whether this chat is connected, how to connect or stop.
   In a group the bot still answers only its commands. */
const TG_SENDS = "• по понедельникам — план на ближайшие недели;\n"
  + "• за 7, 3 и 1 день до срока — напоминание;\n"
  + "• код доступа, если забудешь его.";
const TG_HELP_LINKED = "Это бот IITALY. Твой кабинет подключён, я присылаю:\n" + TG_SENDS + "\n\n"
  + "Отвечать на вопросы здесь я не умею — спроси ИИ-помощника в кабинете: " + PORTAL_URL + "\n\n"
  + "Отключить напоминания: /stop";
const TG_HELP_GUEST = "Это бот напоминаний IITALY. Чтобы получать план и напоминания о сроках, "
  + "открой личный кабинет и нажми «Подключить Telegram» — появится безопасная ссылка: " + PORTAL_URL + "\n\n"
  + "Отвечать на вопросы здесь я не умею — спроси ИИ-помощника на сайте.";
/** Ближайшие три шага плана — чтобы сразу после подключения было видно, зачем бот. */
function nextStepsText(c) {
  const steps = buildRoadmap(null, c.profile, c.intakeYear).flatMap(stage => stage.tasks || [])
    .filter(t => t.deadline && Number.isFinite(t.daysLeft) && t.daysLeft >= 0 && !(c.done && c.done[t.id]))
    .sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 3);
  return steps.length ? "\n\nБлижайшее по плану:\n" + steps.map(t => "• " + ruDate(t.deadline) + " — " + t.t).join("\n") : "";
}
function tgChatLinked(chatId) {
  return listClients().some(f => {
    const cl = readClient(f.replace(/\.json$/, ""));
    return Boolean(cl && cl.tgChatId === chatId);
  });
}

app.post("/api/tg/webhook", async (req, res) => {
  res.json({ ok: true });                       // отвечаем сразу, Telegram не ждёт
  try {
    /* Without the secret nothing is accepted. Before, a server started
       without TG_WEBHOOK_SECRET took any request for a message from Telegram:
       a stranger could switch off someone's reminders with a forged /stop. */
    const secret = String(process.env.TG_WEBHOOK_SECRET || "");
    if (!safeEqual(String((req.headers || {})["x-telegram-bot-api-secret-token"] || ""), secret)) return;

    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || !msg.text) return;
    const chatId = msg.chat.id;
    const text = String(msg.text).trim();

    if (/^\/stop\b/i.test(text)) {
      const files = listClients();
      let off = 0;
      for (const f of files) {
        const cl = readClient(f.replace(/\.json$/, ""));
        if (cl && cl.tgChatId === chatId) {
          cl.tgChatId = null;
          cl.notify = cl.notify || {};
          cl.notify.telegram = false;
          delete cl.tgLink;
          writeClient(cl.code, cl);
          off++;
        }
      }
      await tgSendTo(chatId, off
        ? "Готово, напоминания в Telegram выключены. Включить снова: кабинет → Настройки → Напоминания.\n" + PORTAL_URL
        : "Этот чат не подключён к кабинету — выключать нечего.");
      return;
    }

    const m = text.match(/^\/start\s+([A-Za-z0-9_-]{32,64})$/);
    if (!m) {
      const command = /^\/(start|help)\b/i.test(text);
      if (command || msg.chat.type === "private") await tgSendTo(chatId, tgChatLinked(chatId) ? TG_HELP_LINKED : TG_HELP_GUEST);
      return;
    }

    const match = findClientByToken(
      m[1],
      () => listClients().map(f => f.replace(/\.json$/, "")),
      readClient,
    );
    if (!match) {
      await tgSendTo(chatId, "Ссылка устарела или уже использована: она работает 15 минут и один раз. "
        + "Открой кабинет и нажми «Подключить Telegram» ещё раз.\n" + PORTAL_URL);
      return;
    }

    const c = match.client;
    c.tgChatId = chatId;
    c.notify = c.notify || {};
    c.notify.telegram = true;
    delete c.tgLink;
    if (!writeClient(match.code, c)) {
      await tgSendTo(chatId, "Не удалось сохранить подключение. Вернись в кабинет и попробуй ещё раз.");
      return;
    }

    let steps = "";
    try { steps = nextStepsText(c); } catch { /* без плана — только приветствие */ }
    await tgSendTo(chatId, "Готово, " + c.name + "! Telegram подключён к кабинету IITALY.\n\n"
      + "Что буду присылать:\n" + TG_SENDS + steps + "\n\n"
      + "Кабинет: " + PORTAL_URL + "\nОтключить: /stop");
    console.log("TG SUBSCRIBED");
  } catch {
    console.error("tg webhook error");
  }
});

// Отписка
app.post("/api/tg/webhook/stop", (_req, res) => res.json({ ok: true }));

/* ================= НАПОМИНАНИЯ О ДЕДЛАЙНАХ =================
   Сводка в понедельник и срочные пороги 7/3/1 день. Статус каждого
   получателя хранится отдельно; удачная отправка владельцу не закрывает
   неудачную попытку студенту. Логика и изолированные тесты — reminders.js. */

function listClients() {
  try { return fs.readdirSync(STORE_DIR + "/clients").filter((f) => f.endsWith(".json")); }
  catch (e) { return []; }
}

async function tgSendTo(chatId, text) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const r = await fetchWithTimeout("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
    });
    return r.ok;
  } catch (e) { return false; }
}

// Receipt updates must not truncate an existing client file if a write fails.
// Same encrypted format, same volume; rename only after the temporary write.
function writeReminderClient(code, data) {
  if (!validCode(code)) return false;
  const destination = clientPath(code);
  const temporary = destination + ".reminder-" + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(temporary, encKey ? encrypt(json) : json, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    console.warn("REMINDERS: receipt write failed");
    return false;
  }
}

const baseRunReminders = createReminderRunner({
  listCodes: () => listClients().map(file => file.replace(/\.json$/, "")),
  readClient,
  writeClient: writeReminderClient,
  buildRoadmap: client => buildRoadmap(null, client.profile, client.intakeYear),
  siteUrl: PUBLIC_SITE,
  channelsFor: client => ({
    telegram: {
      enabled: Boolean(process.env.TG_BOT_TOKEN && client.tgChatId && client.notify && client.notify.telegram !== false),
      target: client.tgChatId,
      transport: "telegram",
      send: text => sendTelegramReminder(process.env.TG_BOT_TOKEN, client.tgChatId, text),
    },
    email: {
      enabled: Boolean(mailer && client.email && client.notify && client.notify.email !== false),
      target: client.email,
      transport: "email",
      send: async (text, subject) => ({ ok: await sendMail(client.email, subject, text) }),
    },
    /* Копия каждого напоминания каждого ученика владельцу больше не уходит
       (владелец, 24 ноября: одно и то же приходило дважды). Вместо неё —
       сводка раз в неделю, maybeSendOwnerDigest ниже. */
    owner: {
      enabled: false,
      target: process.env.TG_CHAT_ID,
      transport: "telegram",
      send: text => sendTelegramReminder(process.env.TG_BOT_TOKEN, process.env.TG_CHAT_ID, text),
    },
  }),
});
let lastReminderStats = null;
async function runReminders() {
  const result = await baseRunReminders();
  lastReminderStats = { ...result, at: new Date().toISOString() };
  try { await maybeSendOwnerDigest(baseRunReminders.now ? baseRunReminders.now() : new Date()); }
  catch { console.warn("OWNER DIGEST: failed; will retry on a later tick"); }
  return result;
}

/* Владельцу — одна сводка в неделю: понедельник, днём по Казахстану.
   Неделя отмечается в файле, чтобы перезапуск не прислал сводку второй раз.
   Только числа, без имён и кодов. Демо-кабинет не считается. */
const OWNER_DIGEST_FILE = () => STORE_DIR + "/owner-digest.json";
function ownerDigestText(now) {
  let pupils = 0, linked = 0, fresh = 0, soonPupils = 0, soonSteps = 0, latePupils = 0;
  for (const file of listClients()) {
    const c = readClient(file.replace(/\.json$/, ""));
    if (!c || c.demo) continue;
    pupils++;
    if (c.tgChatId) linked++;
    if (Date.parse(c.createdAt) > now.getTime() - 7 * 864e5) fresh++;
    let soon = 0, late = false;
    for (const t of buildRoadmap(null, c.profile, c.intakeYear).flatMap(stage => stage.tasks || [])) {
      if (!t.deadline || !Number.isFinite(t.daysLeft) || (c.done && c.done[t.id])) continue;
      if (t.daysLeft >= 0 && t.daysLeft <= 7) soon++;
      if (t.daysLeft < 0 && t.daysLeft >= -LATE_WINDOW_DAYS) late = true;
    }
    if (soon) { soonPupils++; soonSteps += soon; }
    if (late) latePupils++;
  }
  return "📊 IITALY за неделю\n\n"
    + `Учеников с кабинетом: ${pupils}, новых за 7 дней: ${fresh}\n`
    + `Подключили Telegram: ${linked} из ${pupils}\n`
    + `Срок на этой неделе: у ${soonPupils} (шагов: ${soonSteps})\n`
    + `Срок недавно прошёл, шаг не отмечен: у ${latePupils}`;
}
async function maybeSendOwnerDigest(now) {
  const chat = process.env.TG_CHAT_ID;
  if (!process.env.TG_BOT_TOKEN || !chat) return;
  const local = new Date(now.getTime() + SEND_WINDOW.utcOffsetHours * 3600e3);
  if (local.getUTCDay() !== 1 || !inSendWindow(now, SEND_WINDOW)) return;
  const week = local.toISOString().slice(0, 10);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(OWNER_DIGEST_FILE(), "utf8")).week; } catch { /* первая сводка */ }
  if (last === week) return;
  if (await tgSendTo(chat, ownerDigestText(now))) {
    try { fs.writeFileSync(OWNER_DIGEST_FILE(), JSON.stringify({ week })); }
    catch { console.warn("OWNER DIGEST: week mark not saved"); }
  }
}

// A lightweight tick retries failed channels; receipts prevent repeat sends.
// Existing opt-out switch and legacy replay suppression are preserved.
if (process.env.REMINDERS !== "off") {
  setTimeout(() => { runReminders().catch(() => console.warn("REMINDERS: tick failed")); }, 60 * 1000);
  setInterval(() => { runReminders().catch(() => console.warn("REMINDERS: tick failed")); }, RETRY_MS);
}

// Existing authenticated manual endpoint; uses the same single-flight runner.
app.get("/api/reminders/run", async (req, res) => {
  if (!adminAllowed(req, (req.query || {}).key)) return res.status(403).json({ ok: false, error: "forbidden" });
  try {
    const result = await runReminders();
    res.json({ ok: true, ...result });
  } catch {
    res.status(500).json({ ok: false, error: "Не удалось проверить напоминания" });
  }
});

// --- Аналитика: приём событий ---
const EVENT_RE = /^[a-z0-9_]{2,40}$/;
// The site sends «w-<time>-<random>»; a tab or a line break here would forge log lines.
const DEVICE_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
/* Logs share the volume with the cabinets. Each keeps at most two files of
   this size, so a flood of events cannot fill the volume and stop saves. */
const eventsLog = createCappedLog(fs, EVENTS_LOG, 25 * 1024 * 1024);
const leadsLog = createCappedLog(fs, LEADS_LOG, 5 * 1024 * 1024);
const ordersLog = createCappedLog(fs, ORDERS_LOG, 5 * 1024 * 1024);
app.post("/api/event", eventLimit, async (req, res) => {
  try {
    const { event, deviceId, props } = req.body || {};
    if (typeof event !== "string" || !EVENT_RE.test(event) ||
        typeof deviceId !== "string" || !DEVICE_RE.test(deviceId)) {
      return res.status(400).json({ ok: false });
    }
    const propsStr = props && typeof props === "object"
      ? JSON.stringify(props).slice(0, 200) : "{}";
    eventsLog.append(`${Date.now()}\t${event}\t${deviceId}\t${propsStr}`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- Сводка воронки: GET /api/stats?key=<STATS_KEY из env> ---
const FUNNEL = ["app_open", "onboarding_done", "chat_message_sent", "tab_price", "buy_open", "order_submitted"];
app.get("/api/stats", (req, res) => {
  if (!adminAllowed(req, (req.query || {}).key)) return res.status(403).json({ error: "forbidden" });
  fs.readFile(EVENTS_LOG, "utf8", (err, current) => {
    let older = "";
    try { older = fs.readFileSync(eventsLog.older, "utf8"); } catch { /* журнал ещё не переносился */ }
    const data = older + (err ? "" : current);
    if (!data) return res.json({ funnel: [], events: {} });
    const totals = {}, uniques = {};
    for (const line of data.split("\n")) {
      if (!line) continue;
      const [, event, deviceId] = line.split("\t");
      if (!event) continue;
      totals[event] = (totals[event] || 0) + 1;
      (uniques[event] = uniques[event] || new Set()).add(deviceId);
    }
    const funnel = FUNNEL.map((ev, i) => {
      const u = uniques[ev] ? uniques[ev].size : 0;
      const prev = i > 0 && uniques[FUNNEL[i - 1]] ? uniques[FUNNEL[i - 1]].size : null;
      return {
        step: ev,
        uniqueDevices: u,
        total: totals[ev] || 0,
        convFromPrev: prev ? Math.round((u / prev) * 100) + "%" : "—",
      };
    });
    const events = {};
    for (const ev of Object.keys(totals)) {
      events[ev] = { total: totals[ev], unique: uniques[ev].size };
    }
    res.json({ funnel, events });
  });
});

// --- Лиды из онбординга ---
app.post("/api/lead", orderLimit, async (req, res) => {
  try {
    const { education, goal, budget, phone } = req.body || {};
    const clean = (v) => plainText(v, 40);
    const line = `${new Date().toISOString()} | LEAD | ${clean(education)} | ${clean(goal)} | ${clean(budget)} | ${clean(phone) || "-"}`;
    console.log("LEAD");   // the phone number stays out of the hosting log
    leadsLog.append(line);
    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    // The owner is messaged only about something that looks like a phone number.
    if (token && chat && /^[+0-9() -]{7,20}$/.test(clean(phone))) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `👤 Новый лид IITALY\n${clean(education)} → ${clean(goal)}\nБюджет: ${clean(budget)}\nТел: ${clean(phone)}`,
        }),
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

/* What the site sells. The friends' 667 ₸ «Тестовый доступ · для друзей»
   (22 Nov) is off sale since the launch (owner, 23 Nov: «убери теперь опцию
   для друзей, сайт запустили!!»): a request naming it is refused like any
   unknown product. Orders already made keep the fulfilment stored with them,
   so cabinets opened by test purchases are not affected. */
const PRODUCT_CATALOG = new Map([
  ["Поступление под ключ", { price: 10990, fulfillment: "portal" }],
  ["Срочная проверка · 1 документ", { price: 16900, fulfillment: "manual" }],
]);

function productOffer(name) {
  return PRODUCT_CATALOG.get(String(name || "")) || null;
}

function makeOrderToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

function orderTokenMatches(order, token) {
  if (!order || !order.accessTokenHash || typeof token !== "string") return false;
  const expected = Buffer.from(String(order.accessTokenHash), "hex");
  const actual = Buffer.from(crypto.createHash("sha256").update(token).digest("hex"), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function activatePortalOrder(order) {
  if (!order || order.fulfillment !== "portal") return { ok: false, error: "not_portal" };
  const existing = order.portalCode ? readClient(order.portalCode) : findClientByOrderId(order.id);
  if (existing) {
    order.portalCode = existing.code;
    order.status = "activated";
    order.activatedAt = order.activatedAt || existing.createdAt;
    order.updatedAt = new Date().toISOString();
    orderStore.write(order);
    return { ok: true, code: existing.code, data: existing, alreadyActivated: true };
  }
  if (String(order.surname || "").trim().length < 2) return { ok: false, error: "surname" };
  const created = createPortalClient({
    name: order.name,
    surname: order.surname,
    phone: order.phone,
    email: order.email || "",
    sourceOrderId: order.id,
  });
  if (!created.ok) return created;
  order.portalCode = created.code;
  order.status = "activated";
  order.activatedAt = new Date().toISOString();
  order.updatedAt = order.activatedAt;
  if (!orderStore.write(order)) return { ok: false, error: "order_write" };
  return { ok: true, code: created.code, data: created.data, alreadyActivated: false };
}

// --- Приём заказов ---
function validBuyerFields({ product, name, surname, phone }) {
  return typeof product === "string" && product.length <= 100 &&
    typeof name === "string" && name.trim().length >= 2 && name.length <= 60 &&
    typeof surname === "string" && surname.trim().length >= 2 && surname.length <= 60 &&
    typeof phone === "string" && /^[+0-9() -]{10,18}$/.test(phone);
}

/* Почта при покупке — по желанию (владелец, 20 Nov: восстановление кода).
   Пусто или нет поля — заказ проходит как раньше; старый сайт её не шлёт. */
function buyerEmail(value) {
  if (value === undefined || value === null || value === "") return { ok: true, email: "" };
  if (typeof value !== "string") return { ok: false };
  const email = value.trim();
  if (!email) return { ok: true, email: "" };
  return email.length <= 80 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { ok: true, email } : { ok: false };
}

// Legacy/manual order endpoint remains available for operational fallback.
app.post("/api/order", orderLimit, async (req, res) => {
  try {
    const { product, name, surname, phone } = req.body || {};
    const offer = productOffer(product);
    if (!offer || !validBuyerFields({ product, name, surname, phone })) {
      return res.status(400).json({ ok: false, error: "Проверь услугу, имя, фамилию и телефон." });
    }
    const contact = buyerEmail((req.body || {}).email);
    if (!contact.ok) return res.status(400).json({ ok: false, error: "Проверь адрес почты." });

    const order = orderStore.create({ product, price: offer.price, name, surname, phone, email: contact.email });
    order.fulfillment = offer.fulfillment;
    order.provider = "manual";
    if (!orderStore.write(order)) return res.status(500).json({ ok: false, error: "Не удалось сохранить заказ." });
    ordersLog.append([order.createdAt, order.id, order.product, order.price, order.status, order.provider].join("\t"));
    console.log("ORDER CREATED:", order.id);
    res.json({ ok: true, orderId: order.id });
  } catch {
    console.error("order error");
    res.status(500).json({ ok: false, error: "Ошибка сервера." });
  }
});

// Create a Stripe-hosted Checkout Session. The server owns the product price:
// the browser cannot override the catalogue amount.
app.post("/api/stripe/checkout", orderLimit, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ ok: false, error: "Оплата картой пока не настроена." });
    }
    const { product, name, surname, phone } = req.body || {};
    const offer = productOffer(product);
    if (!offer || !validBuyerFields({ product, name, surname, phone })) {
      return res.status(400).json({ ok: false, error: "Проверь услугу, имя, фамилию и телефон." });
    }
    const contact = buyerEmail((req.body || {}).email);
    if (!contact.ok) return res.status(400).json({ ok: false, error: "Проверь адрес почты." });

    const access = makeOrderToken();
    const order = orderStore.create({ product, price: offer.price, name, surname, phone, email: contact.email });
    Object.assign(order, {
      fulfillment: offer.fulfillment,
      provider: "stripe",
      accessTokenHash: access.hash,
      status: "checkout_creating",
      updatedAt: new Date().toISOString(),
    });
    if (!orderStore.write(order)) {
      return res.status(500).json({ ok: false, error: "Не удалось сохранить заказ." });
    }

    const session = await createCheckoutSession({
      secretKey: process.env.STRIPE_SECRET_KEY,
      order,
      siteUrl: PUBLIC_SITE,
    });
    if (!session.ok) {
      order.status = "checkout_failed";
      order.updatedAt = new Date().toISOString();
      orderStore.write(order);
      return res.status(502).json({ ok: false, error: "Stripe временно не создал страницу оплаты. Попробуй ещё раз." });
    }

    order.stripeSessionId = session.id;
    order.status = "checkout_created";
    order.updatedAt = new Date().toISOString();
    if (!orderStore.write(order)) {
      return res.status(500).json({ ok: false, error: "Сессия оплаты создана, но заказ не сохранился. Не оплачивай и попробуй ещё раз." });
    }
    ordersLog.append([order.createdAt, order.id, order.product, order.price, order.status, order.provider].join("\t"));
    console.log("STRIPE CHECKOUT CREATED:", order.id);
    res.json({ ok: true, url: session.url, orderId: order.id, orderToken: access.token });
  } catch {
    console.error("stripe checkout error");
    res.status(500).json({ ok: false, error: "Не удалось открыть оплату." });
  }
});

// Browser polling after Stripe redirects back. Credentials are returned only
// to the browser holding the random token created before checkout.
app.post("/api/order/status", orderStatusLimit, (req, res) => {
  const { orderId, orderToken } = req.body || {};
  const order = orderStore.read(String(orderId || ""));
  if (!order || !orderTokenMatches(order, orderToken)) {
    return res.status(404).json({ ok: false, error: "Заказ не найден." });
  }
  const payload = {
    ok: true,
    status: order.status,
    fulfillment: order.fulfillment || "manual",
    paidAt: order.paidAt || null,
  };
  if (order.status === "activated" && order.portalCode) {
    payload.portal = { code: order.portalCode, surname: order.surname };
  }
  res.json(payload);
});

// Stripe signature verification must use the exact raw request bytes.
// The raw parser is selected above specifically for this route.
app.post("/api/stripe/webhook", async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const event = parseVerifiedEvent(req.body, req.headers["stripe-signature"], secret);
  if (!event) return res.status(400).json({ ok: false });

  const session = event.data.object || {};
  const orderId = String(session.metadata?.order_id || session.client_reference_id || "");
  const order = orderStore.read(orderId);

  if (event.type === "checkout.session.expired") {
    if (order && order.stripeSessionId === session.id &&
        !["paid", "activated"].includes(order.status)) {
      order.status = "expired";
      order.updatedAt = new Date().toISOString();
      order.stripeEventId = event.id;
      orderStore.write(order);
    }
    return res.json({ received: true });
  }

  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
    return res.json({ received: true });
  }

  if (!order || order.provider !== "stripe" || order.stripeSessionId !== session.id) {
    return res.status(409).json({ ok: false });
  }
  if (session.payment_status !== "paid" ||
      String(session.currency || "").toLowerCase() !== STRIPE_CURRENCY ||
      Number(session.amount_total) !== minorUnits(order.price)) {
    return res.status(409).json({ ok: false });
  }

  // Replayed Stripe events are harmless: fulfillment is idempotent.
  order.paidAt = order.paidAt || new Date().toISOString();
  order.stripeEventId = event.id;
  order.stripePaymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : null;
  order.updatedAt = new Date().toISOString();

  let fulfilled = null;
  if (order.fulfillment === "portal") {
    fulfilled = activatePortalOrder(order);
    if (!fulfilled.ok) return res.status(500).json({ ok: false });
  } else {
    order.status = "paid";
    if (!orderStore.write(order)) return res.status(500).json({ ok: false });
  }

  // Acknowledge only after the durable state change. The Telegram owner alert
  // is best-effort and does not determine whether Stripe sees this as success.
  res.json({ received: true });
  const tgToken = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (tgToken && chat) {
    const who = [order.surname, order.name].filter(Boolean).join(" ") + (order.phone ? " · " + order.phone : "");
    const text = "💳 Оплата " + Number(order.price).toLocaleString("ru-RU") + " ₸ · " + order.product + "\n" + who
      + (fulfilled?.code ? "\nКабинет создан, код: " + fulfilled.code : "\nУслугу нужно выполнить вручную — свяжись с клиентом.")
      + "\nЗаказ: " + order.id;
    fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    }).catch(() => {});
  }
});

function adminAuth(req, res, next) {
  if (!adminAllowed(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}

function clientAdminSummary(client) {
  const roadmap = buildRoadmap(null, client.profile, client.intakeYear);
  let total = 0, done = 0;
  for (const stage of roadmap) for (const task of stage.tasks || []) {
    total++; if (client.done && client.done[task.id]) done++;
  }
  return {
    code: client.code,
    name: client.name,
    surname: client.surname,
    phone: client.phone || "",
    createdAt: client.createdAt,
    intakeYear: client.intakeYear,
    tgLinked: Boolean(client.tgChatId),
    progress: { done, total, pct: total ? Math.round(done / total * 100) : 0 },
    sourceOrderId: client.sourceOrderId || null,
  };
}

app.get("/api/admin/overview", adminAuth, (_req, res) => {
  const clients = [];
  for (const file of listClients()) {
    const client = readClient(file.replace(/\.json$/, ""));
    if (client) clients.push(clientAdminSummary(client));
  }
  const orders = orderStore.list().map(order => ({
    id: order.id,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    product: order.product,
    price: order.price,
    name: order.name,
    surname: order.surname || "",
    phone: order.phone,
    email: order.email || "",
    portalCode: order.portalCode || null,
    activatedAt: order.activatedAt || null,
    provider: order.provider || "manual",
    fulfillment: order.fulfillment || productOffer(order.product)?.fulfillment || "manual",
  }));
  res.json({
    ok: true,
    orders,
    clients: clients.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    reminder: lastReminderStats,
    storage: { persistent: STORE_DIR === DATA_DIR },
  });
});

app.post("/api/admin/orders/:id/confirm", adminAuth, async (req, res) => {
  const order = orderStore.read(String(req.params.id || ""));
  if (!order) return res.status(404).json({ ok: false, error: "Заказ не найден" });

  const offer = productOffer(order.product);
  order.fulfillment = order.fulfillment || offer?.fulfillment || "manual";
  if (order.fulfillment !== "portal") {
    order.status = "paid";
    order.paidAt = order.paidAt || new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    if (!orderStore.write(order)) return res.status(500).json({ ok: false, error: "Не удалось сохранить статус" });
    return res.json({ ok: true, manual: true, phone: order.phone, alreadyActivated: false });
  }

  if (!order.surname) order.surname = String(req.body?.surname || "").trim();
  const fulfilled = activatePortalOrder(order);
  if (!fulfilled.ok) {
    const status = fulfilled.error === "surname" ? 400 : 500;
    return res.status(status).json({ ok: false, error: fulfilled.error === "surname" ? "Для активации нужна фамилия" : "Не удалось создать кабинет" });
  }

  res.json({
    ok: true,
    code: fulfilled.code,
    name: fulfilled.data.name,
    surname: fulfilled.data.surname,
    phone: order.phone,
    alreadyActivated: fulfilled.alreadyActivated,
  });
});

app.post("/api/admin/clients/create", adminAuth, async (req, res) => {
  const created = createPortalClient(req.body || {});
  if (!created.ok) {
    const status = created.error === "name" ? 400 : 500;
    return res.status(status).json({ ok: false, error: created.error === "name" ? "Укажи имя и фамилию" : "Не удалось создать кабинет" });
  }
  res.json({ ok: true, code: created.code, name: created.data.name, surname: created.data.surname, phone: created.data.phone || "" });
});

app.post("/api/admin/reminders/run", adminAuth, async (_req, res) => {
  try {
    const result = await runReminders();
    res.json({ ok: true, ...result });
  } catch {
    res.status(500).json({ ok: false, error: "Не удалось запустить напоминания" });
  }
});


// Optional synthetic demo account for regression testing.
// Contains no real customer data and is deliberately isolated from orders.
if (process.env.DEMO_PORTAL === "on") {
  const demoCode = "DEMO-2027";
  if (!readClient(demoCode)) {
    const now = new Date().toISOString();
    const demo = {
      code: demoCode,
      name: "Demo",
      surname: "Testov",
      phone: "",
      email: "",
      tgChatId: null,
      notify: { email: false, telegram: true },
      profile: {
        education: "11 классов",
        goal: "Бакалавриат",
        budget: "Без стипендии будет сложно",
      },
      intakeYear: 2027,
      done: {},
      docs: {},
      demo: true,
      createdAt: now,
      updatedAt: now,
    };
    if (writeClient(demoCode, demo)) console.log("DEMO PORTAL READY");
    else console.warn("DEMO PORTAL: failed to seed");
  }
}

/* Anything that is not a route answers with JSON, and an error inside a
   handler answers with one line instead of the framework's page: outside
   production mode that page prints the stack and the file paths. */
app.use((_req, res) => res.status(404).json({ ok: false, error: "Не найдено." }));
app.use((err, _req, res, next) => {
  console.error("unhandled route error:", (err && err.name) || "unknown");
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: "Внутренняя ошибка сервера." });
});
/* A rejected promise in a handler must not stop the process: one crafted
   request would otherwise restart the server for everyone. */
if (typeof process.on === "function") {
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection:", (reason && reason.name) || "unknown");
  });
}

/* Settings that leave a door open. The server keeps working without them, so
   the owner hears about it in Telegram at start instead of from the logs. */
function weakSettings(env) {
  const weak = [];
  if (!env.DATA_KEY) weak.push("DATA_KEY не задан: данные кабинетов лежат на диске без шифрования.");
  if (String(env.STATS_KEY || "").length < 24) weak.push("STATS_KEY короче 24 символов: ключ владельца можно подобрать. Поставь длинную случайную строку.");
  if (env.TG_BOT_TOKEN && !env.TG_WEBHOOK_SECRET) weak.push("TG_WEBHOOK_SECRET не задан: бот не принимает сообщения, пока секрета нет.");
  if (!String(env.ALLOWED_ORIGINS || "").trim()) weak.push("ALLOWED_ORIGINS пуст: к серверу может обращаться страница любого сайта.");
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) weak.push("STRIPE_WEBHOOK_SECRET не задан: оплата не подтвердится.");
  return weak;
}

const PORT = process.env.PORT || 3000;
/* Проверка настроек при старте: лучше увидеть предупреждение в логах,
   чем обнаружить неработающую функцию через неделю. */
(function checkEnv(){
  const need = {
    ANTHROPIC_API_KEY: "ИИ-чат и проверка документов",
    STATS_KEY: "выдача доступа и статистика",
    TG_BOT_TOKEN: "уведомления о заказах",
    TG_CHAT_ID: "уведомления о заказах",
  };
  const opt = {
    TG_BOT_NAME: "кнопка подключения бота в кабинете",
    SITE_URL: "ссылки в письмах и сообщениях",
    SMTP_HOST: "письма с напоминаниями",
    STRIPE_SECRET_KEY: "Stripe Checkout",
    STRIPE_WEBHOOK_SECRET: "проверка Stripe webhook",
  };
  const miss = Object.keys(need).filter((k) => !process.env[k]);
  const missOpt = Object.keys(opt).filter((k) => !process.env[k]);
  if (miss.length) {
    console.warn("НЕ РАБОТАЕТ без настройки:");
    for (const k of miss) console.warn("  " + k + " → " + need[k]);
  }
  if (missOpt.length) {
    console.log("Отключено (необязательно): " + missOpt.map((k) => k + " → " + opt[k]).join("; "));
  }
  if (STORE_DIR !== DATA_DIR) {
    console.warn("ВНИМАНИЕ: тома нет, данные клиентов сотрутся при следующем деплое");
  }
  if (!ALLOWED_ORIGINS.length) {
    console.warn("ALLOWED_ORIGINS не задан — API отвечает любому сайту. "
      + "Пропиши список через запятую, например https://iitaly.kz,https://iitaly.netlify.app");
  } else {
    console.log("CORS разрешён только для: " + ALLOWED_ORIGINS.join(", "));
  }
  console.log("Модель: " + MODEL);
  if (!process.env.DATA_KEY) {
    console.warn("DATA_KEY не задан — данные клиентов лежат открытым текстом. "
      + "Задай длинную случайную строку и НЕ МЕНЯЙ её: при смене старые файлы не прочитаются.");
  } else {
    console.log("Данные клиентов шифруются");
  }
  if (!miss.length) console.log("Обязательные переменные заданы; доступ к ИИ проверяется отдельно");
})();

app.listen(PORT, () => {
  console.log(`IITALY proxy up on :${PORT}`);
  void aiReadiness.check();
  const weak = weakSettings(process.env);
  if (weak.length) ownerAlert("⚠️ IITALY, настройки сервера:\n• " + weak.join("\n• "));
});
