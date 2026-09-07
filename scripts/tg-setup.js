#!/usr/bin/env node
// Регистрирует / проверяет / снимает вебхук Telegram-бота напоминаний.
//
//   npm run tg:setup    — зарегистрировать вебхук на BACKEND_URL/api/tg/webhook
//   npm run tg:status   — показать текущее состояние вебхука в Telegram
//   npm run tg:remove   — снять вебхук (для отладки/переезда на другой домен)
//
// Нужны переменные окружения TG_BOT_TOKEN и BACKEND_URL (см. .env.example).
// Без TG_WEBHOOK_SECRET тоже сработает, но тогда любой, кто узнает URL
// вебхука, сможет слать на него поддельные апдейты — секрет желателен.

const fs = require("fs");
const path = require("path");

// Простой .env-загрузчик — без внешней зависимости. Не переопределяет
// переменные, уже заданные в окружении (Railway задаёт их напрямую).
function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const TOKEN = process.env.TG_BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL;
const SECRET = process.env.TG_WEBHOOK_SECRET;
const MODE = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--delete")
    ? "delete"
    : "set";

if (!TOKEN) {
  console.error("TG_BOT_TOKEN не задан — впиши его в .env или в Railway Variables (см. .env.example).");
  process.exit(1);
}
if (MODE === "set" && !BACKEND_URL) {
  console.error("BACKEND_URL не задан — нужен публичный URL этого бэкенда (см. .env.example).");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

// Telegram при сетевых сбоях/блокировке на стороне хоста иногда отвечает
// не JSON (страница ошибки прокси и т.п.) — разбираем это в понятное
// сообщение, а не роняем скрипт сырой "Unexpected token" ошибкой.
async function callTelegram(path, options) {
  const res = await fetch(`${API}/${path}`, options);
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Telegram вернул не JSON (HTTP ${res.status}) — похоже, api.telegram.org недоступен из этой сети. ` +
        `Запусти скрипт там, где есть прямой доступ в интернет (Railway, локальная машина). Ответ: ${raw.slice(0, 200)}`,
    );
  }
}

async function main() {
  if (MODE === "check") {
    const r = await callTelegram("getWebhookInfo");
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
    if (!r.result.url) console.warn("\nВебхук не зарегистрирован — запусти `npm run tg:setup`.");
    return;
  }

  if (MODE === "delete") {
    const r = await callTelegram("deleteWebhook", { method: "POST" });
    console.log(r.ok ? "Вебхук снят." : "Не удалось снять вебхук: " + JSON.stringify(r));
    if (!r.ok) process.exit(1);
    return;
  }

  const url = BACKEND_URL.replace(/\/$/, "") + "/api/tg/webhook";
  const body = { url, allowed_updates: ["message"] };
  if (SECRET) body.secret_token = SECRET;

  const r = await callTelegram("setWebhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    console.error("Не удалось зарегистрировать вебхук:", JSON.stringify(r));
    process.exit(1);
  }
  console.log("Вебхук зарегистрирован на " + url + (SECRET ? " (с секретом)" : " (без секрета — рекомендую задать TG_WEBHOOK_SECRET)"));
  console.log("Проверить: npm run tg:status");
}

main().catch((e) => {
  console.error("Ошибка запроса к Telegram API:", e.message);
  process.exit(1);
});
