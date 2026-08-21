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
  r = await j("POST", "/api/order", { product: "Гайд по DSU", price: 1990, name: "Тест", phone: "+77071234567" });
  ok(r.status === 200 && r.data?.ok === true, "POST /api/order валидный → 200");

  // 6. order: кривой телефон
  r = await j("POST", "/api/order", { product: "x", price: 1, name: "A", phone: "abc" });
  ok(r.status === 400, "POST /api/order кривой телефон → 400");

  // 7. lead
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

  console.log("\n" + (fail === 0 ? "ВСЁ ПРОШЛО" : fail + " ПРОВАЛОВ") + " — pass: " + pass + ", fail: " + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
