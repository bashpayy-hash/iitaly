// smoke-test.js — проверка всех эндпоинтов одной командой.
// Запуск: STATS_KEY=test123 node server.js &  затем  node smoke-test.js
// Или против прод-сервера: BASE=https://xxx.up.railway.app node smoke-test.js
const BASE = process.env.BASE || "http://localhost:3000";
const KEY = process.env.STATS_KEY || "test123";

let pass = 0, fail = 0;
const ok = (cond, name) => { console.log((cond ? "  ✓ " : "  ✗ ") + name); cond ? pass++ : fail++; };

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

(async () => {
  console.log("Проверяю " + BASE + "\n");

  // 1. health
  let r = await j("GET", "/health");
  ok(r.status === 200 && r.data?.ok === true, "GET /health → 200 {ok:true}");

  // 2. chat: пустой массив отбивается
  r = await j("POST", "/api/chat", { messages: [] });
  ok(r.status === 400, "POST /api/chat пустой → 400");

  // 3. chat: кривая роль отбивается
  r = await j("POST", "/api/chat", { messages: [{ role: "hacker", content: "x" }] });
  ok(r.status === 400, "POST /api/chat кривая роль → 400");

  // 4. chat: валидный запрос — 200 (если ключ есть) или 502 (если нет), но НЕ краш
  r = await j("POST", "/api/chat", { messages: [{ role: "user", content: "Привет, что такое DSU?" }] });
  ok(r.status === 200 || r.status === 502, "POST /api/chat валидный → " + r.status + (r.status === 200 ? " (ключ работает)" : " (нет ключа — ожидаемо локально)"));
  if (r.status === 200) console.log("     ответ ИИ: " + String(r.data?.reply || "").slice(0, 80) + "…");

  // 5. order: валидный
  r = await j("POST", "/api/order", { product: "Поступление под ключ", price: 667, name: "Тест", surname: "Пользователь", phone: "+77071234567" });
  ok(r.status === 200 && r.data?.ok === true, "POST /api/order валидный → 200");

  // 6. order: кривой телефон
  r = await j("POST", "/api/order", { product: "x", price: 1, name: "A", phone: "abc" });
  ok(r.status === 400, "POST /api/order кривой телефон → 400");

  // 7. Stripe is safely disabled until account secrets are configured
  r = await j("POST", "/api/stripe/checkout", {
    product: "Поступление под ключ", name: "Тест", surname: "Пользователь", phone: "+77071234567"
  });
  ok(r.status === 503 && r.data?.ok === false, "POST /api/stripe/checkout без Stripe secret → 503");

  // 8. lead
  r = await j("POST", "/api/lead", { education: "11 классов", goal: "Бакалавриат", budget: "Только со стипендией", phone: "+77071234567" });
  ok(r.status === 200, "POST /api/lead → 200");

  // 8. event
  r = await j("POST", "/api/event", { event: "app_open", deviceId: "d-smoke", props: {} });
  ok(r.status === 200, "POST /api/event → 200");

  // 9. event: инъекция отбивается
  r = await j("POST", "/api/event", { event: "DROP TABLE;", deviceId: "x" });
  ok(r.status === 400, "POST /api/event мусор → 400");

  // 10. stats без ключа
  r = await j("GET", "/api/stats");
  ok(r.status === 403, "GET /api/stats без ключа → 403");

  // 11. stats с ключом
  r = await j("GET", "/api/stats?key=" + KEY);
  ok(r.status === 200 && Array.isArray(r.data?.funnel), "GET /api/stats?key=… → 200 воронка");

  // 12. кабинет: новый POST-вход отвечает и не пускает по выдуманному коду
  r = await j("POST", "/api/portal/lookup", { code: "AAAA-AAAA", surname: "Несуществующий" });
  ok(r.status === 404 && r.data?.ok === false, "POST /api/portal/lookup неверный код → 404");

  // 13. кабинет: старый GET оставлен рабочим ради раздельного деплоя фронта и бэка
  r = await j("GET", "/api/portal/AAAA-AAAA?surname=Несуществующий");
  ok(r.status === 404 && r.data?.ok === false, "GET /api/portal/:code (старый путь) → 404");

  // 14. кабинет: выход за пределы папки с данными через код доступа
  r = await j("POST", "/api/portal/lookup", { code: "../../etc", surname: "x" });
  ok(r.status === 404, "POST /api/portal/lookup обход каталога → 404");

  // 15. Telegram: кабинет создаёт одноразовую ссылку без кода доступа в URL
  r = await j("POST", "/api/portal/create", {
    key: KEY,
    name: "Telegram",
    surname: "Testov",
    phone: "",
    email: "",
    profile: {},
    intakeYear: 2027,
  });
  const tgCode = r.data?.code;
  ok(r.status === 200 && typeof tgCode === "string", "POST /api/portal/create для Telegram-теста → 200");

  r = await j("POST", "/api/portal/" + encodeURIComponent(tgCode) + "/telegram-link", { surname: "Testov" });
  const tgUrl = String(r.data?.url || "");
  ok(r.status === 200 && r.data?.ok === true && /^https:\/\/t\.me\/IitalyReminderTestBot\?start=[A-Za-z0-9_-]{32,64}$/.test(tgUrl),
    "POST /api/portal/:code/telegram-link → одноразовая t.me ссылка");
  ok(!tgUrl.includes(tgCode), "Telegram-ссылка не содержит код кабинета");

  r = await j("POST", "/api/portal/lookup", { code: tgCode, surname: "Testov" });
  ok(r.status === 200 && r.data?.client?.notify?.email === false,
    "новый кабинет не обещает email-рассылку без настроенной почты");

  r = await j("POST", "/api/portal/" + encodeURIComponent(tgCode) + "/delete", {
    surname: "Testov",
    confirm: "УДАЛИТЬ",
  });
  ok(r.status === 200 && r.data?.ok === true, "тестовый кабинет удалён");

  /* 19. Цены в промпте совпадают с ценами на сайте.
     Проверка статическая и стоит здесь не случайно: расхождение уже
     случалось — промпт называл 27 000 ₸, пока витрина показывала
     667 ₸, и это заметили не тесты, а разбор кода. Цифры внизу
     дублируют src/data/pricing.ts во фронтенд-репозитории; меняются
     оба места одним заходом. */
  const prompt = require("fs").readFileSync(__dirname + "/system-prompt.txt", "utf8");
  ok(prompt.includes("667 \u20b8"), "промпт называет цену 667 ₸");
  ok(!prompt.includes("27 000 \u20b8"), "в промпте нет старой цены 27 000 ₸");
  ok(prompt.includes("16 900 \u20b8"), "промпт называет срочную проверку 16 900 ₸");
  // Границу слева проверяем вручную: «16 900 ₸» содержит в себе «6 900 ₸»,
  // и наивный includes() ронял тест на разрешённой цене.
  const ghosts = ["6 900", "8 900", "9 900", "12 900", "20 900", "28 900", "39 900"];
  const found = ghosts.filter((g) => new RegExp("(^|[^0-9])" + g + "\\s*\u20b8").test(prompt));
  ok(found.length === 0, "промпт не продаёт услуг, которых нет на сайте"
    + (found.length ? " — нашлись: " + found.join(", ") : ""));

  console.log("\n" + (fail === 0 ? "ВСЁ ПРОШЛО" : fail + " ПРОВАЛОВ") + " — pass: " + pass + ", fail: " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
