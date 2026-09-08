// IItaly — прокси для ИИ-чата (production-ready)
// Запуск локально: ANTHROPIC_API_KEY=sk-... node server.js
// Деплой: Railway / Render — ключ в env-переменной ANTHROPIC_API_KEY

const express = require("express");
const fs = require("fs");
const { buildRoadmap, defaultIntakeYear } = require("./roadmap");

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
    await mailer.sendMail({
      from: process.env.SMTP_FROM || ("IItaly <" + process.env.SMTP_USER + ">"),
      to, subject, text,
    });
    return true;
  } catch (e) {
    console.error("mail failed:", e.message);
    return false;
  }
}
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
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);   // preflight
  next();
});

app.use(express.json({ limit: "8mb" }));

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
    console.error("read client failed:", e.message);
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
// Код доступа: без похожих символов, чтобы диктовать по телефону
function makeCode() {
  const A = "ACDEFHJKLMNPRTUVWXY3479";
  let out = "";
  for (let i = 0; i < 8; i++) out += A[Math.floor(Math.random() * A.length)];
  return out.slice(0, 4) + "-" + out.slice(4);
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
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) console.warn("WARN: ANTHROPIC_API_KEY не задан — чат не будет работать");

// --- Простейший rate limit: 20 запросов / 5 минут с одного IP ---
const hits = new Map();
const WINDOW_MS = 5 * 60 * 1000, MAX_HITS = 20;

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

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const now = Date.now();
  const rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW_MS) { rec.count = 0; rec.start = now; }
  rec.count++;
  hits.set(ip, rec);
  if (rec.count > MAX_HITS) {
    return res.status(429).json({ reply: "Слишком много запросов. Подожди пару минут и попробуй снова." });
  }
  next();
}
// Периодическая очистка карты, чтобы не текла память
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > WINDOW_MS) hits.delete(ip);
}, WINDOW_MS);

// --- Health check для Railway/Render ---
app.get("/health", (_req, res) => res.json({ ok: true }));

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
        model: "claude-sonnet-4-6",
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

app.post("/api/check-document", rateLimit, async (req, res) => {
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
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: CHECK_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!r.ok) {
      console.error("Anthropic error (check-document):", r.status, await r.text().catch(() => ""));
      return res.status(502).json({ ok: false, error: "Сервис проверки временно недоступен. Попробуй через минуту." });
    }

    const data = await r.json();
    const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    }
    if (!parsed) {
      console.error("check-document: не удалось разобрать ответ модели");
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

    const { name, surname, phone, email, profile, intakeYear } = req.body || {};
    if (typeof name !== "string" || name.trim().length < 2) return res.status(400).json({ ok: false, error: "Укажи имя" });
    if (typeof surname !== "string" || surname.trim().length < 2) return res.status(400).json({ ok: false, error: "Укажи фамилию" });

    let code = makeCode();
    for (let i = 0; i < 5 && readClient(code); i++) code = makeCode();

    const data = {
      code,
      name: String(name).slice(0, 60),
      surname: String(surname).slice(0, 60),
      phone: typeof phone === "string" ? phone.slice(0, 20) : "",
      email: typeof email === "string" && /.+@.+\..+/.test(email) ? email.trim().slice(0, 80) : "",
      tgChatId: null,          // заполнится, когда клиент нажмёт Start у бота
      notify: { email: true, telegram: true },
      profile: profile && typeof profile === "object" ? profile : {},
      intakeYear: Number.isInteger(intakeYear) && intakeYear > 2024 && intakeYear < 2100
        ? intakeYear : defaultIntakeYear(),
      done: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!writeClient(code, data)) return res.status(500).json({ ok: false, error: "Не удалось сохранить" });

    console.log("PORTAL CREATED: " + code);   // без имени: логи хранит хостинг
    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (token && chat) {
      fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: "\u{1F511} Кабинет создан\n" + data.surname + " " + data.name + "\nКод: " + code }),
      }).catch(() => {});
    }
    res.json({ ok: true, code });
  } catch (e) {
    console.error("portal create error:", e.message);
    res.status(500).json({ ok: false, error: "Внутренняя ошибка" });
  }
});

// Состояние кабинета по коду доступа
// Нормализация фамилии: регистр, пробелы, е/ё — чтобы вход не зависел от мелочей
function normSurname(v) {
  return String(v || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

app.get("/api/portal/:code", rateLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().slice(0, 12);
  const c = readClient(code);
  // одинаковый ответ на неверный код и неверную фамилию: не подсказываем, что именно не так
  const deny = () => res.status(404).json({ ok: false, error: "Не нашли бронь. Проверь фамилию и код." });
  if (!c) return deny();
  if (normSurname(req.query.surname) !== normSurname(c.surname)) return deny();

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
});

// Отметить задачу выполненной или снять отметку
app.post("/api/portal/:code/task", rateLimit, (req, res) => {
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
app.post("/api/portal/:code/doc", rateLimit, (req, res) => {
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
app.post("/api/portal/:code/delete", rateLimit, (req, res) => {
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
  console.log("PORTAL DELETED: " + code);
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
app.post("/api/portal/:code/notify", rateLimit, (req, res) => {
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
    if (!notifyTelegram) c.tgChatId = null;
  }
  if (!writeClient(code, c)) return res.status(500).json({ ok: false, error: "Не удалось сохранить" });
  res.json({ ok: true, email: c.email || "", tgLinked: !!c.tgChatId, notify: c.notify });
});

/* ---------- Подписка клиента на бота ----------
   Студент открывает ссылку t.me/бот?start=КОД, жмёт Start —
   Telegram шлёт сюда апдейт, и мы привязываем его чат к кабинету. */
app.post("/api/tg/webhook", async (req, res) => {
  res.json({ ok: true });                       // отвечаем сразу, Telegram не ждёт
  try {
    const secret = process.env.TG_WEBHOOK_SECRET;
    if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return;

    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || !msg.text) return;
    const chatId = msg.chat.id;
    const text = String(msg.text).trim();

    // отписка: обещали команду — она должна работать
    if (/^\/stop\b/i.test(text)) {
      const files = listClients();
      let off = 0;
      for (const f of files) {
        const cl = readClient(f.replace(/\.json$/, ""));
        if (cl && cl.tgChatId === chatId) {
          cl.tgChatId = null;
          cl.notify = cl.notify || {};
          cl.notify.telegram = false;
          writeClient(cl.code, cl);
          off++;
        }
      }
      await tgSendTo(chatId, off
        ? "Напоминания в Telegram отключены. Включить обратно можно в кабинете на сайте."
        : "Этот чат не привязан к кабинету — отключать нечего.");
      return;
    }

    const m = text.match(/^\/start\s+([A-Z0-9-]{4,12})$/i);
    if (!m) {
      if (/^\/start/.test(text)) {
        await tgSendTo(chatId, "Это бот напоминаний IItaly. Открой кабинет на сайте и нажми «Включить напоминания» — ссылка придёт с твоим кодом.");
      }
      return;
    }

    const code = m[1].toUpperCase();
    const c = readClient(code);
    if (!c) { await tgSendTo(chatId, "Не нашли кабинет по этому коду. Проверь ссылку."); return; }

    c.tgChatId = chatId;
    c.notify = c.notify || {};
    c.notify.telegram = true;
    writeClient(code, c);

    await tgSendTo(chatId, "Готово, " + c.name + "! Напоминания включены.\n\n"
      + "По понедельникам буду присылать сводку по ближайшим шагам, "
      + "а если до дедлайна останется 7, 3 или 1 день — напишу отдельно.\n\n"
      + "Отключить: /stop");
    console.log("TG SUBSCRIBED: " + code + " → chat " + chatId);
  } catch (e) {
    console.error("tg webhook error:", e.message);
  }
});

// Отписка
app.post("/api/tg/webhook/stop", (_req, res) => res.json({ ok: true }));

/* ================= НАПОМИНАНИЯ О ДЕДЛАЙНАХ =================
   Раз в сутки проходим по кабинетам и шлём напоминание владельцу в Telegram
   за 30, 14, 7, 3 и 1 день до срока, плюс один раз при просрочке.
   Каждое напоминание уходит ровно один раз: отметка пишется в файл клиента. */

/* Срочные пороги: только то, что реально горит. Всё остальное уходит
   в еженедельную сводку — иначе за сезон человек получит десятки сообщений. */
const URGENT_AT = [7, 3, 1];
const DIGEST_DAY = 1;          // понедельник
const DIGEST_HORIZON = 45;     // о чём напоминаем в сводке

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

async function tgSend(text) {
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetchWithTimeout("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function runReminders() {
  const files = listClients();
  if (!files.length) return { checked: 0, sent: 0 };
  let sent = 0;
  const isDigestDay = new Date().getDay() === DIGEST_DAY;

  for (const f of files) {
    const code = f.replace(/\.json$/, "");
    const c = readClient(code);
    if (!c) continue;

    const roadmap = buildRoadmap(null, c.profile, c.intakeYear);
    c.reminded = c.reminded || {};
    const due = [];
    const digest = [];
    const keys = [];   // отметки ставим ТОЛЬКО после успешной отправки

    for (const st of roadmap) {
      for (const t of st.tasks) {
        if (c.done[t.id] || t.daysLeft === null) continue;

        // просрочка: напоминаем один раз
        if (t.daysLeft < 0) {
          const key = t.id + ":over";
          if (!c.reminded[key]) { due.push({ t, kind: "over" }); keys.push(key); }
          continue;
        }
        // срочное: до срока неделя или меньше
        const mark = URGENT_AT.find((d) => t.daysLeft <= d && !c.reminded[t.id + ":" + d]);
        if (mark !== undefined) {
          due.push({ t, kind: "soon", mark });
          keys.push(t.id + ":" + mark);
          continue;
        }
        // остальное копим для еженедельной сводки
        if (isDigestDay && t.daysLeft <= DIGEST_HORIZON) digest.push(t);
      }
    }

    // сводка уходит не чаще раза в неделю
    const weekKey = "digest:" + new Date().toISOString().slice(0, 10);
    const sendDigest = isDigestDay && digest.length && !c.reminded[weekKey];
    if (!due.length && !sendDigest) continue;

    let lines = due.slice(0, 6).map((x) =>
      (x.kind === "over"
        ? "\u{26A0} просрочено на " + (-x.t.daysLeft) + " дн"
        : "\u{23F0} через " + x.t.daysLeft + " дн") + " — " + x.t.t);
    let tail = due.length > 6 ? "\n… и ещё " + (due.length - 6) : "";

    if (sendDigest) {
      digest.sort((a, b) => a.daysLeft - b.daysLeft);
      const dl = digest.slice(0, 5).map((t) => "\u{2022} через " + t.daysLeft + " дн — " + t.t);
      lines = lines.concat(lines.length ? ["", "Ближайшие полтора месяца:"] : ["Ближайшие полтора месяца:"], dl);
      if (digest.length > 5) tail = "\n… и ещё " + (digest.length - 5) + " шагов в кабинете";
      keys.push(weekKey);
    }

    // --- владельцу: сводка с кодом кабинета ---
    const ownerText = "Напоминание по клиенту\n" + c.surname + " " + c.name + " · код " + code + "\n\n" + lines.join("\n") + tail;
    const okOwner = await tgSend(ownerText);

    // --- клиенту: то же, но своим языком ---
    const clientText = "Привет, " + c.name + "! Напоминание по твоему поступлению:\n\n"
      + lines.join("\n") + tail
      + "\n\nОткрыть кабинет: " + (process.env.SITE_URL || "https://iitaly.netlify.app")
      + "/#portal — фамилия и код " + code;

    let okClient = false;
    if (c.notify && c.notify.telegram !== false && c.tgChatId) {
      okClient = await tgSendTo(c.tgChatId, clientText);
    }
    if (c.notify && c.notify.email !== false && c.email) {
      const subj = due.some((x) => x.kind === "over")
        ? "IItaly: есть просроченные шаги"
        : "IItaly: скоро дедлайн по поступлению";
      const mailText = clientText
        + "\n\n———\nОтключить письма: зайди в кабинет → Помощь → Напоминания, "
        + "или ответь на это письмо словом «отписка».";
      const okMail = await sendMail(c.email, subj, mailText);
      okClient = okClient || okMail;
    }

    // отметки ставим, только если сообщение реально ушло хоть куда-то
    if (okOwner || okClient) {
      const now = new Date().toISOString();
      for (const k of keys) c.reminded[k] = now;
      writeClient(code, c);
      sent++;
    } else {
      console.warn("REMINDERS: не отправлено для " + code + ", повторим позже");
    }
  }
  console.log("REMINDERS: кабинетов " + files.length + ", отправлено " + sent);
  return { checked: files.length, sent };
}

// Проверяем раз в сутки. Первый прогон через минуту после старта,
// чтобы перезапуск сервера не рассылал всё разом.
const DAY_MS = 24 * 60 * 60 * 1000;
if (process.env.REMINDERS !== "off") {
  setTimeout(() => { runReminders().catch(() => {}); }, 60 * 1000);
  setInterval(() => { runReminders().catch(() => {}); }, DAY_MS);
}

// Ручной запуск для проверки: /api/reminders/run?key=STATS_KEY
app.get("/api/reminders/run", async (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key || req.query.key !== key) return res.status(403).json({ ok: false, error: "forbidden" });
  const r = await runReminders();
  res.json({ ok: true, ...r });
});

// --- Аналитика: приём событий ---
const EVENT_RE = /^[a-z0-9_]{2,40}$/;
app.post("/api/event", async (req, res) => {
  try {
    const { event, deviceId, props } = req.body || {};
    if (typeof event !== "string" || !EVENT_RE.test(event) ||
        typeof deviceId !== "string" || deviceId.length > 40) {
      return res.status(400).json({ ok: false });
    }
    const propsStr = props && typeof props === "object"
      ? JSON.stringify(props).slice(0, 200) : "{}";
    const line = `${Date.now()}\t${event}\t${deviceId.slice(0, 40)}\t${propsStr}`;
    fs.appendFile(__dirname + "/events.log", line + "\n", () => {});
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
  fs.readFile(__dirname + "/events.log", "utf8", (err, data) => {
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
app.post("/api/lead", rateLimit, async (req, res) => {
  try {
    const { education, goal, budget, phone } = req.body || {};
    const clean = (v) => (typeof v === "string" ? v.slice(0, 40) : "");
    const line = `${new Date().toISOString()} | LEAD | ${clean(education)} | ${clean(goal)} | ${clean(budget)} | ${clean(phone) || "-"}`;
    console.log(line);
    fs.appendFile(__dirname + "/leads.log", line + "\n", () => {});
    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (token && chat && clean(phone)) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `👤 Новый лид IItaly\n${clean(education)} → ${clean(goal)}\nБюджет: ${clean(budget)}\nТел: ${clean(phone)}`,
        }),
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// --- Приём заказов микро-продуктов ---
// Заказ логируется и (если настроен Telegram-бот) улетает основателю.
// Env: TG_BOT_TOKEN (токен бота от @BotFather), TG_CHAT_ID (твой chat id от @userinfobot)
app.post("/api/order", rateLimit, async (req, res) => {
  try {
    const { product, price, name, phone } = req.body || {};
    if (typeof product !== "string" || product.length > 100 ||
        typeof name !== "string" || name.length < 2 || name.length > 60 ||
        typeof phone !== "string" || !/^[+0-9() -]{10,18}$/.test(phone)) {
      return res.status(400).json({ ok: false, error: "Проверь имя и телефон." });
    }
    const line = `${new Date().toISOString()} | ${product} | ${price || "?"} ₸ | ${name} | ${phone}`;
    console.log("ORDER:", product, price + " ₸");   // имя и телефон только в Telegram, не в логах
    fs.appendFile(__dirname + "/orders.log", line + "\n", () => {});

    const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
    if (token && chat) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `🛒 Новый заказ IItaly\n${product} — ${price || "?"} ₸\n${name}, ${phone}`,
        }),
      }).catch((e) => console.error("tg notify failed:", e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("order error:", e.message);
    res.status(500).json({ ok: false, error: "Ошибка сервера." });
  }
});

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
  if (!process.env.DATA_KEY) {
    console.warn("DATA_KEY не задан — данные клиентов лежат открытым текстом. "
      + "Задай длинную случайную строку и НЕ МЕНЯЙ её: при смене старые файлы не прочитаются.");
  } else {
    console.log("Данные клиентов шифруются");
  }
  if (!miss.length) console.log("Настройки в порядке");
})();

app.listen(PORT, () => console.log(`IItaly proxy up on :${PORT}`));
