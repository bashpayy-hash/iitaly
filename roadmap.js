// roadmap.js — маршрут поступления, по которому система ведёт клиента.
// Даты считаются от учебного года, на который поступает клиент (intakeYear),
// а не от текущего календаря: иначе сроки «уезжают» при смене года.

// Ключевые даты цикла. offset: 0 — год подачи, -1 — год до старта учёбы.
// Для приёма 2026/27 подача идёт в 2026 году, учёба начинается в сентябре 2026.
const DEADLINES = {
  chooseUni:    { m: 11, d: 30, y: -1, label: "Определиться с вузами и программами" },
  cimeaStart:   { m: 2,  d: 15, y: 0,  label: "Запустить CIMEA: делается 30–60 дней" },
  apostille:    { m: 1,  d: 31, y: 0,  label: "Апостиль и переводы: заложить 4–6 недель" },
  testReg:      { m: 3,  d: 31, y: 0,  label: "Регистрация на вступительный тест" },
  sapienzaPre:  { m: 5,  d: 15, y: 0,  label: "Sapienza: pre-enrolment для визовых" },
  uniApply:     { m: 6,  d: 30, y: 0,  label: "Заявки в вузы: большинство закрывается" },
  discoDsu:     { m: 7,  d: 22, y: 0,  label: "DiSCo Lazio: подача на DSU" },
  iseeu:        { m: 6,  d: 30, y: 0,  label: "ISEEU parificato: оформить до подачи на DSU" },
  familyDocs:   { m: 5,  d: 31, y: 0,  label: "Справки семьи: собрать заранее" },
  ergoDsu:      { m: 8,  d: 31, y: 0,  label: "ER.GO: подача на DSU" },
  universitaly: { m: 9,  d: 30, y: 0,  label: "Universitaly: финальный дедлайн" },
  imat:         { m: 9,  d: 30, y: 0,  label: "IMAT: медицина на английском" },
  money:        { m: 4,  d: 30, y: 0,  label: "Гарантия должна «пожить» на счёте" },
  blsSlot:      { m: 6,  d: 15, y: 0,  label: "Слот в BLS: в сезон разбирают быстро" },
  visaSubmit:   { m: 7,  d: 31, y: 0,  label: "Подача на визу: рассмотрение до 90 дней" },
  arrival:      { m: 9,  d: 20, y: 0,  label: "Приезд к началу учёбы" },
  permesso:     { m: 10, d: 5,  y: 0,  label: "Permesso: 8 рабочих дней после въезда" },
};

// Дата в формате ГГГГ-ММ-ДД для конкретного года подачи
function dateFor(key, intakeYear) {
  const d = DEADLINES[key];
  if (!d) return null;
  const y = intakeYear + (d.y || 0);
  return y + "-" + String(d.m).padStart(2, "0") + "-" + String(d.d).padStart(2, "0");
}

// Ближайший реальный набор. Цикл подачи идёт с осени по сентябрь следующего года,
// поэтому с июня новому клиенту разумно целиться уже в следующий год:
// к этому моменту заявки в вузы и подача на DSU текущего цикла закрываются.
function defaultIntakeYear() {
  const now = new Date();
  return now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear();
}

const STAGES = [
  {
    id: "start",
    title: "Старт и профиль",
    tiers: ["Lite", "Standard", "Flagship"],
    tasks: [
      { id: "profile", t: "Заполнить профиль: класс, оценки, бюджет, город мечты", ai: true },
      { id: "shortlist", t: "Получить персональный shortlist программ", ai: true, dl: "chooseUni" },
      { id: "chances", t: "Проверить шансы на DSU по доходу семьи", ai: true },
    ],
  },
  {
    id: "education12",
    title: "Требование 12 лет образования",
    tiers: ["Lite", "Standard", "Flagship"],
    skipIf: (p) => p.education === "НИШ / 12 лет" || p.education === "Бакалавр" || p.goal === "Магистратура",
    tasks: [
      { id: "path12", t: "Выбрать путь: год вуза в КЗ или foundation year", ai: true },
      { id: "enroll12", t: "Поступить и закрыть первую сессию (если выбран вуз КЗ)" },
    ],
  },
  {
    id: "docs",
    title: "Документы и признание",
    tiers: ["Lite", "Standard", "Flagship"],
    tasks: [
      { id: "apostille", t: "Проставить апостиль на аттестат или диплом", dl: "apostille", warn: "Апостиль только на оригинал и только ДО перевода" },
      { id: "translate", t: "Присяжный перевод на итальянский", dl: "apostille" },
      { id: "notary", t: "Нотариальное заверение подписи переводчика + апостиль на нём", dl: "apostille" },
      { id: "cimea", t: "Подать на CIMEA Statement of Comparability", dl: "cimeaStart", note: "30–60 дней, €65–150" },
      { id: "checkDocs", t: "Прогнать все документы через AI-проверку", ai: true },
    ],
  },
  {
    id: "apply",
    title: "Подача в университет",
    tiers: ["Standard", "Flagship"],
    tasks: [
      { id: "test", t: "Записаться и сдать вступительный тест (TOLC / IMAT / внутренний)", dl: "testReg" },
      { id: "uniApply", t: "Подать заявку в выбранные вузы", dl: "uniApply" },
      { id: "universitaly", t: "Заполнить pre-enrolment на Universitaly", dl: "universitaly", warn: "Без него визу не дадут" },
      { id: "checkpoint1", t: "Экспертная проверка перед подачей", expert: true, dl: "uniApply" },
    ],
  },
  {
    id: "dsu",
    title: "Стипендия DSU",
    tiers: ["Flagship"],
    skipIf: (p) => p.budget === "Без ограничений",
    tasks: [
      { id: "familyDocs", t: "Собрать справки семьи за референсный год", dl: "familyDocs", warn: "Для приёма 2026/27 — доходы за 2024, счета на 31.12.2024" },
      { id: "iseeu", t: "Оформить ISEEU parificato через CAF", dl: "iseeu" },
      { id: "dsuApply", t: "Подать заявку в региональное агентство", dl: "discoDsu", note: "DiSCo — июль, ER.GO — август, Toscana — сентябрь" },
      { id: "checkpoint2", t: "Экспертная проверка пакета DSU", expert: true, dl: "iseeu" },
    ],
  },
  {
    id: "visa",
    title: "Виза D",
    tiers: ["Standard", "Flagship"],
    tasks: [
      { id: "money", t: "Обеспечить финансовую гарантию на счёте", dl: "money", note: "€6 947,33 за каждый год обучения" },
      { id: "statements", t: "Получить банковские выписки за 3 месяца с QR", dl: "blsSlot" },
      { id: "insurance", t: "Оформить медицинскую страховку", dl: "visaSubmit" },
      { id: "housing", t: "Подтвердить жильё", dl: "visaSubmit" },
      { id: "blsSlot", t: "Записаться в BLS", dl: "blsSlot", warn: "Лимит 30 студенческих заявок в день" },
      { id: "visaSubmit", t: "Подать документы на визу", dl: "visaSubmit", warn: "Не позднее 15 дней до выезда" },
      { id: "checkpoint3", t: "Экспертная проверка визового досье", expert: true, dl: "blsSlot" },
    ],
  },
  {
    id: "arrival",
    title: "Первые дни в Италии",
    tiers: ["Standard", "Flagship"],
    tasks: [
      { id: "kit", t: "Kit giallo на почте", dl: "permesso", warn: "В первые 8 рабочих дней после въезда" },
      { id: "codice", t: "Получить codice fiscale", dl: "permesso" },
      { id: "questura", t: "Приём в Questura, отпечатки", dl: "permesso" },
    ],
  },
];

// Сколько дней осталось до даты (отрицательное — просрочено)
function daysLeft(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  return Math.round((d - today) / 86400000);
}

function buildRoadmap(tier, profile, intakeYear) {
  const p = profile || {};
  const year = intakeYear || defaultIntakeYear();
  const out = [];
  for (const st of STAGES) {
    if (!st.tiers.includes(tier)) continue;
    if (st.skipIf && st.skipIf(p)) continue;
    out.push({
      id: st.id,
      title: st.title,
      tasks: st.tasks.map((t) => {
        const iso = t.dl ? dateFor(t.dl, year) : null;
        return {
          id: t.id,
          t: t.t,
          ai: !!t.ai,
          expert: !!t.expert,
          note: t.note || null,
          warn: t.warn || null,
          deadline: iso,
          deadlineLabel: t.dl ? DEADLINES[t.dl].label : null,
          daysLeft: iso ? daysLeft(iso) : null,
        };
      }),
    });
  }
  return out;
}

module.exports = { buildRoadmap, DEADLINES, dateFor, defaultIntakeYear, daysLeft };
