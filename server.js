// IItaly — прокси для ИИ-чата (production-ready)
// Запуск локально: ANTHROPIC_API_KEY=sk-... node server.js
// Деплой: Railway / Render — ключ в env-переменной ANTHROPIC_API_KEY

const express = require("express");
const fs = require("fs");
const app = express();
// 8 МБ: фото документа в base64 весит 1-6 МБ. Чат и заказы валидируются отдельно по длине.
// CORS: браузер не пустит запрос с сайта на другой домен без этих заголовков.
// Разрешаем всем — эндпоинты и так защищены rate limit, а ключ живёт только здесь.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);   // preflight-запрос браузера
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

    const r = await fetch("https://api.anthropic.com/v1/messages", {
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
app.post("/api/check-document", rateLimit, async (req, res) => {
  try {
    if (!CHECK_PROMPT) return res.status(503).json({ ok: false, error: "Проверка документов временно недоступна." });
    const { image, mediaType, hint, text } = req.body || {};

    let content;
    if (typeof image === "string" && image.length > 100) {
      const b64 = image.includes(",") ? image.split(",").pop() : image;
      // ~7.5 МБ base64 ≈ 5.6 МБ файла — предел Anthropic API
      if (b64.length > 7_500_000) {
        return res.status(413).json({ ok: false, error: "Файл слишком большой. Сожми фото или сними при меньшем разрешении." });
      }
      const mt = ALLOWED_MEDIA.includes(mediaType) ? mediaType : "image/jpeg";
      content = [
        { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
        { type: "text", text: "Проверь этот документ." + (typeof hint === "string" && hint ? " Пользователь считает, что это: " + hint.slice(0, 100) : "") },
      ];
    } else if (typeof text === "string" && text.trim().length > 20) {
      content = [{ type: "text", text: "Проверь этот документ (текстовое содержимое):\n\n" + text.slice(0, 12000) }];
    } else {
      return res.status(400).json({ ok: false, error: "Пришли фото документа или его текст." });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
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
    console.log("ORDER:", line);
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
app.listen(PORT, () => console.log(`IItaly proxy up on :${PORT}`));
