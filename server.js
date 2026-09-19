// IITALY — прокси для ИИ-чата (production-ready)
// Запуск локально: ANTHROPIC_API_KEY=sk-... node server.js
// Деплой: Railway / Render — ключ в env-переменной ANTHROPIC_API_KEY

const express = require("express");
const fs = require("fs");
const { buildRoadmap, defaultIntakeYear } = require("./roadmap");
const { createReminderRunner, RETRY_MS } = require("./reminders");
const { sendTelegramReminder } = require("./reminder-telegram");
const { makeLinkToken, findClientByToken } = require("./telegram-linking");
const { createOrderStore } = require("./order-store");
const { CURRENCY: STRIPE_CURRENCY, minorUnits, createCheckoutSession, parseVerifiedEvent } = require("./stripe-checkout");

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

const jsonParser = express.json({ limit: "8mb" });
const stripeRawParser = express.raw({ type: "application/json", limit: "1mb" });
app.use((req, res, next) => {
  if (req.path === "/api/stripe/webhook") return stripeRawParser(req, res, next);
  return jsonParser(req, res, next);
});

// Ошибки разбора тела отдаём как JSON, а не HTML-страницей
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Файл слишком большой. Сожми фото или сними при меньшем разрешении." });
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
function writeClient(code, data) {
  if (!validCode(code)) return false;
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(clientPath(code), encKey ? encrypt(json) : json);
    return true;
  } catch (e) { console.error("write client failed:", e.message); return false; }
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
  const A = "ACDEFHJKLMNPRTUVWXY3479";
  let out = "";
  for (let i = 0; i < 8; i++) out += A[Math.floor(Math.random() * A.length)];
  return out.slice(0, 4) + "-" + out.slice(4);
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
    email: typeof fields.email === "string" && /.+@.+\..+/.test(fields.email) ? fields.email.trim().slice(0, 80) : "",
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
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) console.warn("WARN: ANTHROPIC_API_KEY не задан — чат не будет работать");

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
const buckets = new Map();   // имя корзины → Map(ip → { count, start })

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
}

function makeLimit(name, max, windowMs = WINDOW_MS, message) {
  const hits = new Map();
  buckets.set(name, hits);
  return function limit(req, res, next) {
    const ip = clientIp(req);
    const now = Date.now();
    const rec = hits.get(ip) || { count: 0, start: now };
    if (now - rec.start > windowMs) { rec.count = 0; rec.start = now; }
    rec.count++;
    hits.set(ip, rec);
    if (rec.count > max) {
      const retry = Math.ceil((rec.start + windowMs - now) / 1000);
      res.set("Retry-After", String(retry));
      // чат ждёт поле reply, остальные — error; отдаём оба, чтобы
      // любой клиент показал человеку текст, а не «ошибка сервера»
      const text = message || "Слишком много запросов. Подожди пару минут и попробуй снова.";
      return res.status(429).json({ ok: false, reply: text, error: text });
    }
    next();
  };
}

const rateLimit = makeLimit("chat", 30);
const heavyLimit = makeLimit("document", 12, WINDOW_MS,
  "Проверка документов ограничена: 12 файлов за 5 минут. Подожди немного.");
const portalLimit = makeLimit("portal", 60);
const eventLimit = makeLimit("event", 300, WINDOW_MS, "Слишком много событий.");
const orderLimit = makeLimit("order", 10, WINDOW_MS,
  "Слишком много заявок подряд. Подожди пару минут.");

/* Вход в кабинет — отдельно и строже. Код из 8 символов подобрать
   перебором нереально (23^8), но лимит закрывает и утечку кода, и
   попытки угадать фамилию к известному коду, и просто шум в логах.
   Считаем ТОЛЬКО неудачные попытки: человек, который спокойно работает
   в своём кабинете, этого лимита не видит вообще. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_FAILS = 10;
const loginFails = new Map();
buckets.set("login", loginFails);

function loginBlocked(req) {
  const rec = loginFails.get(clientIp(req));
  if (!rec) return false;
  if (Date.now() - rec.start > LOGIN_WINDOW_MS) return false;
  return rec.count >= LOGIN_MAX_FAILS;
}
function noteLoginFail(req) {
  const ip = clientIp(req), now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, start: now };
  if (now - rec.start > LOGIN_WINDOW_MS) { rec.count = 0; rec.start = now; }
  rec.count++;
  loginFails.set(ip, rec);
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

// Периодическая очистка корзин, чтобы не текла память
setInterval(() => {
  const now = Date.now();
  for (const [name, hits] of buckets) {
    const ttl = name === "login" ? LOGIN_WINDOW_MS : WINDOW_MS;
    for (const [ip, rec] of hits) if (now - rec.start > ttl) hits.delete(ip);
  }
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
  });
});

// --- Основной эндпоинт чата ---
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
    // Валидация каждого сообщения: роль и длина
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant") ||
          typeof m.content !== "string" || m.content.length > 4000) {
        return res.status(400).json({ reply: "Некорректный запрос." });
      }
    }

    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT + profileNote,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!r.ok) {
      console.error("Anthropic API error:", r.status, await r.text().catch(() => ""));
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

app.post("/api/check-document", heavyLimit, async (req, res) => {
  try {
    if (!CHECK_PROMPT) return res.status(503).json({ ok: false, error: "Проверка документов временно недоступна." });
    const { image, pdf, mediaType, hint, text, fileName } = req.body || {};
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

    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: ANSWER_TOKENS,
        system: CHECK_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!r.ok) {
      console.error("Anthropic error (check-document):", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ ok: false, error: "Сервис проверки временно недоступен. Попробуй через минуту." });
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
    if (!parsed) {
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
    res.json({ ok: true, result: parsed });
  } catch (e) {
    console.error("check-document error:", e.message);
    res.status(500).json({ ok: false, error: "Внутренняя ошибка сервера." });
  }
});

/* ================= ЛИЧНЫЙ КАБИНЕТ ================= */

// Выдать доступ клиенту после оплаты. Только для владельца: нужен STATS_KEY.
app.post("/api/portal/create", async (req, res) => {
  try {
    const key = process.env.STATS_KEY;
    if (!key || req.body.key !== key) return res.status(403).json({ ok: false, error: "forbidden" });
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
function readPortal(req, res, code, surname) {
  const c = readClient(code);
  // одинаковый ответ на неверный код и неверную фамилию: не подсказываем, что именно не так
  const deny = () => {
    noteLoginFail(req);
    return res.status(404).json({ ok: false, error: "Не нашли бронь. Проверь фамилию и код." });
  };
  if (loginBlocked(req)) {
    return res.status(429).json({ ok: false, error: "Слишком много попыток входа. Попробуй через 15 минут." });
  }
  if (!c) return deny();
  if (normSurname(surname) !== normSurname(c.surname)) return deny();

  const roadmap = buildRoadmap(null, c.profile, c.intakeYear);
  let total = 0, done = 0;
  for (const st of roadmap) for (const t of st.tasks) { total++; if (c.done[t.id]) done++; }

  res.json({
    ok: true,
    client: {
      name: c.name, surname: c.surname, intakeYear: c.intakeYear, createdAt: c.createdAt,
      email: c.email || "", tgLinked: !!c.tgChatId,
      notify: c.notify || { email: true, telegram: true },
      botName: process.env.TG_BOT_NAME || "",
    },
    roadmap,
    done: c.done,
    docs: c.docs || {},
    progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
  });
}

app.post("/api/portal/lookup", portalLimit, (req, res) => {
  const body = req.body || {};
  const code = String(body.code || "").toUpperCase().slice(0, 12);
  readPortal(req, res, code, body.surname);
});

app.get("/api/portal/:code", portalLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  readPortal(req, res, code, req.query.surname);
});

// Отметить задачу выполненной или снять отметку
app.post("/api/portal/:code/task", portalLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  if (!c) return res.status(404).json({ ok: false, error: "Не нашли бронь" });
  if (normSurname(req.body && req.body.surname) !== normSurname(c.surname)) {
    return res.status(403).json({ ok: false, error: "Нет доступа" });
  }

  const { task, value } = req.body || {};
  if (typeof task !== "string" || !/^[a-zA-Z0-9_]{2,30}$/.test(task)) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
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
   Файл не храним — только вердикт и сводку, этого достаточно для досье
   и не создаёт хранилища персональных документов. */
app.post("/api/portal/:code/doc", portalLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  if (!c) return res.status(404).json({ ok: false, error: "Не нашли бронь" });
  if (normSurname(req.body && req.body.surname) !== normSurname(c.surname)) {
    return res.status(403).json({ ok: false, error: "Нет доступа" });
  }
  const { task, result, fileName } = req.body || {};
  if (typeof task !== "string" || !/^[a-zA-Z0-9_]{2,30}$/.test(task)) {
    return res.status(400).json({ ok: false, error: "Некорректная задача" });
  }
  if (!result || typeof result !== "object") {
    return res.status(400).json({ ok: false, error: "Нет результата проверки" });
  }

  const VERDICTS = ["ok", "warn", "error", "unreadable"];
  const verdict = VERDICTS.includes(result.verdict) ? result.verdict : "warn";
  const problems = Array.isArray(result.problems) ? result.problems.length : 0;
  const critical = Array.isArray(result.problems)
    ? result.problems.filter((p) => p && p.severity === "critical").length : 0;

  c.docs = c.docs || {};
  const prev = c.docs[task];
  c.docs[task] = {
    verdict,
    docTitle: String(result.docTitle || "Документ").slice(0, 80),
    summary: String(result.summary || "").slice(0, 400),
    problems, critical,
    fileName: typeof fileName === "string" ? fileName.slice(0, 80) : "",
    checkedAt: new Date().toISOString(),
    attempts: (prev && prev.attempts ? prev.attempts : 0) + 1,
  };

  // документ без критических ошибок закрывает шаг сам
  if (verdict === "ok") c.done[task] = new Date().toISOString();
  else if (critical > 0) delete c.done[task];

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
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  if (!c) return res.status(404).json({ ok: false, error: "Не нашли бронь" });
  if (normSurname(req.body && req.body.surname) !== normSurname(c.surname)) {
    return res.status(403).json({ ok: false, error: "Нет доступа" });
  }
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
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  if (!c) return res.status(404).json({ ok: false, error: "Не нашли бронь" });
  if (normSurname(req.body && req.body.surname) !== normSurname(c.surname)) {
    return res.status(403).json({ ok: false, error: "Нет доступа" });
  }
  const { email, notifyEmail, notifyTelegram } = req.body || {};
  if (typeof email === "string") {
    if (email && !/.+@.+\..+/.test(email)) return res.status(400).json({ ok: false, error: "Проверь адрес почты" });
    c.email = email.trim().slice(0, 80);
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
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  if (!c) return res.status(404).json({ ok: false, error: "Не нашли бронь" });
  if (normSurname(req.body && req.body.surname) !== normSurname(c.surname)) {
    return res.status(403).json({ ok: false, error: "Нет доступа" });
  }

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
   Telegram получает только случайный одноразовый токен, а не код кабинета. */
app.post("/api/tg/webhook", async (req, res) => {
  res.json({ ok: true });                       // отвечаем сразу, Telegram не ждёт
  try {
    const secret = process.env.TG_WEBHOOK_SECRET;
    if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return;

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
        ? "Напоминания в Telegram отключены. Включить обратно можно в кабинете на сайте."
        : "Этот чат не привязан к кабинету — отключать нечего.");
      return;
    }

    const m = text.match(/^\/start\s+([A-Za-z0-9_-]{32,64})$/);
    if (!m) {
      if (/^\/start\b/i.test(text)) {
        await tgSendTo(chatId, "Это бот напоминаний IITALY. Открой личный кабинет на сайте и нажми «Подключить Telegram», чтобы получить новую безопасную ссылку.");
      }
      return;
    }

    const match = findClientByToken(
      m[1],
      () => listClients().map(f => f.replace(/\.json$/, "")),
      readClient,
    );
    if (!match) {
      await tgSendTo(chatId, "Ссылка недействительна или истекла. Вернись в кабинет IITALY и создай новую.");
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

    await tgSendTo(chatId, "Готово, " + c.name + "! Напоминания включены.\n\n"
      + "По понедельникам буду присылать сводку по ближайшим шагам, "
      + "а если до дедлайна останется 7, 3 или 1 день — напишу отдельно.\n\n"
      + "Отключить: /stop");
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
      body: JSON.stringify({ chat_id: chatId, text }),
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
  siteUrl: process.env.SITE_URL || "https://iitaly.netlify.app",
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
    owner: {
      enabled: Boolean(process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID),
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
  return result;
}

// A lightweight tick retries failed channels; receipts prevent repeat sends.
// Existing opt-out switch and legacy replay suppression are preserved.
if (process.env.REMINDERS !== "off") {
  setTimeout(() => { runReminders().catch(() => console.warn("REMINDERS: tick failed")); }, 60 * 1000);
  setInterval(() => { runReminders().catch(() => console.warn("REMINDERS: tick failed")); }, RETRY_MS);
}

// Existing authenticated manual endpoint; uses the same single-flight runner.
app.get("/api/reminders/run", async (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key || req.query.key !== key) return res.status(403).json({ ok: false, error: "forbidden" });
  try {
    const result = await runReminders();
    res.json({ ok: true, ...result });
  } catch {
    res.status(500).json({ ok: false, error: "Не удалось проверить напоминания" });
  }
});

// --- Аналитика: приём событий ---
const EVENT_RE = /^[a-z0-9_]{2,40}$/;
app.post("/api/event", eventLimit, async (req, res) => {
  try {
    const { event, deviceId, props } = req.body || {};
    if (typeof event !== "string" || !EVENT_RE.test(event) ||
        typeof deviceId !== "string" || deviceId.length > 40) {
      return res.status(400).json({ ok: false });
    }
    const propsStr = props && typeof props === "object"
      ? JSON.stringify(props).slice(0, 200) : "{}";
    const line = `${Date.now()}\t${event}\t${deviceId.slice(0, 40)}\t${propsStr}`;
    fs.appendFile(EVENTS_LOG, line + "\n", () => {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- Сводка воронки: GET /api/stats?key=<STATS_KEY из env> ---
const FUNNEL = ["app_open", "onboarding_done", "chat_message_sent", "tab_price", "buy_open", "order_submitted"];
app.get("/api/stats", (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key || req.query.key !== key) return res.status(403).json({ error: "forbidden" });
  fs.readFile(EVENTS_LOG, "utf8", (err, data) => {
    if (err) return res.json({ funnel: [], events: {} });
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
    const clean = (v) => (typeof v === "string" ? v.slice(0, 40) : "");
    const line = `${new Date().toISOString()} | LEAD | ${clean(education)} | ${clean(goal)} | ${clean(budget)} | ${clean(phone) || "-"}`;
    console.log(line);
    fs.appendFile(LEADS_LOG, line + "\n", () => {});
    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (token && chat && clean(phone)) {
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

const PRODUCT_CATALOG = new Map([
  ["Поступление под ключ", { price: 25000, fulfillment: "portal" }],
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

// Legacy/manual order endpoint remains available for operational fallback.
app.post("/api/order", orderLimit, async (req, res) => {
  try {
    const { product, name, surname, phone } = req.body || {};
    const offer = productOffer(product);
    if (!offer || !validBuyerFields({ product, name, surname, phone })) {
      return res.status(400).json({ ok: false, error: "Проверь услугу, имя, фамилию и телефон." });
    }

    const order = orderStore.create({ product, price: offer.price, name, surname, phone });
    order.fulfillment = offer.fulfillment;
    order.provider = "manual";
    if (!orderStore.write(order)) return res.status(500).json({ ok: false, error: "Не удалось сохранить заказ." });
    fs.appendFile(ORDERS_LOG,
      [order.createdAt, order.id, order.product, order.price, order.status, order.provider].join("\t") + "\n",
      () => {});
    console.log("ORDER CREATED:", order.id);
    res.json({ ok: true, orderId: order.id });
  } catch {
    console.error("order error");
    res.status(500).json({ ok: false, error: "Ошибка сервера." });
  }
});

// Create a Stripe-hosted Checkout Session. The server owns the product price:
// the browser cannot change 25 000 ₸ into another amount.
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

    const access = makeOrderToken();
    const order = orderStore.create({ product, price: offer.price, name, surname, phone });
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
      siteUrl: process.env.SITE_URL || "https://iitaly.kz",
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
    fs.appendFile(ORDERS_LOG,
      [order.createdAt, order.id, order.product, order.price, order.status, order.provider].join("\t") + "\n",
      () => {});
    console.log("STRIPE CHECKOUT CREATED:", order.id);
    res.json({ ok: true, url: session.url, orderId: order.id, orderToken: access.token });
  } catch {
    console.error("stripe checkout error");
    res.status(500).json({ ok: false, error: "Не удалось открыть оплату." });
  }
});

// Browser polling after Stripe redirects back. Credentials are returned only
// to the browser holding the random token created before checkout.
app.post("/api/order/status", orderLimit, (req, res) => {
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
    const suffix = fulfilled?.code ? "\nКабинет: " + fulfilled.code : "\nТребуется ручное выполнение услуги.";
    fetch("https://api.telegram.org/bot" + tgToken + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "💳 Stripe: оплачено\n" + order.id + suffix }),
    }).catch(() => {});
  }
});

function safeAdminKey(value) {
  const key = String(process.env.STATS_KEY || "");
  const supplied = String(value || "");
  if (!key || !supplied) return false;
  const a = Buffer.from(key), b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminAuth(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeAdminKey(token)) return res.status(403).json({ ok: false, error: "forbidden" });
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
    portalCode: order.portalCode || null,
    activatedAt: order.activatedAt || null,
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

  let existing = order.portalCode ? readClient(order.portalCode) : findClientByOrderId(order.id);
  if (existing) {
    if (!order.portalCode) {
      order.portalCode = existing.code;
      order.status = "activated";
      order.activatedAt = order.activatedAt || existing.createdAt;
      order.updatedAt = new Date().toISOString();
      orderStore.write(order);
    }
    return res.json({ ok: true, code: existing.code, name: existing.name, surname: existing.surname, phone: order.phone, alreadyActivated: true });
  }

  const surname = String(order.surname || req.body?.surname || "").trim();
  if (surname.length < 2) return res.status(400).json({ ok: false, error: "Для активации нужна фамилия" });

  const created = createPortalClient({
    name: order.name,
    surname,
    phone: order.phone,
    profile: req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : {},
    intakeYear: Number(req.body?.intakeYear),
    sourceOrderId: order.id,
  });
  if (!created.ok) return res.status(500).json({ ok: false, error: "Не удалось создать кабинет" });

  order.surname = surname;
  order.status = "activated";
  order.portalCode = created.code;
  order.activatedAt = new Date().toISOString();
  order.updatedAt = order.activatedAt;
  if (!orderStore.write(order)) return res.status(500).json({ ok: false, error: "Кабинет создан, но статус заказа не сохранился" });

  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (token && chat) {
    fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "✅ Оплата подтверждена\n" + order.id + "\nКабинет: " + created.code }),
    }).catch(() => {});
  }

  res.json({ ok: true, code: created.code, name: created.data.name, surname: created.data.surname, phone: order.phone, alreadyActivated: false });
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
  if (!miss.length) console.log("Настройки в порядке");
})();

app.listen(PORT, () => console.log(`IITALY proxy up on :${PORT}`));
