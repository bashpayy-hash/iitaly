// roadmap.js — персональный маршрут поступления.
// Конкретные даты показываются только когда у нас достаточно данных профиля.
// Для школьника в 11 классе документы, которые появляются только после выпуска,
// не маскируются под "срочные" задачи: они блокируются до получения аттестата.

const DEADLINES = {
  chooseUni:    { m: 11, d: 30, y: -1, label: "Определиться с вузами и программами" },
  cimeaStart:   { m: 2,  d: 15, y: 0,  label: "Начать признание аттестата заранее" },
  apostille:    { m: 1,  d: 31, y: 0,  label: "Заложить время на апостиль и переводы" },
  testReg:      { m: 3,  d: 31, y: 0,  label: "Зарегистрироваться на вступительный тест" },
  uniApply:     { m: 6,  d: 30, y: 0,  label: "Подать заявки в выбранные вузы" },
  discoDsu:     { m: 7,  d: 22, y: 0,  label: "Подготовиться к ранним конкурсам DSU" },
  iseeu:        { m: 6,  d: 30, y: 0,  label: "Оформить ISEEU до подачи на DSU" },
  familyDocs:   { m: 5,  d: 31, y: 0,  label: "Собрать семейные справки заранее" },
  universitaly: { m: 9,  d: 30, y: 0,  label: "Не откладывать Universitaly до конца сезона" },
  money:        { m: 4,  d: 30, y: 0,  label: "Финансовая гарантия должна быть готова заранее" },
  blsSlot:      { m: 6,  d: 15, y: 0,  label: "Начать ловить слот на подачу визы" },
  visaSubmit:   { m: 7,  d: 31, y: 0,  label: "Подать визу с запасом по времени" },
  permesso:     { m: 10, d: 5,  y: 0,  label: "Permesso: в первые рабочие дни после въезда" },
};

function dateFor(key, intakeYear) {
  const d = DEADLINES[key];
  if (!d) return null;
  const y = intakeYear + (d.y || 0);
  return y + "-" + String(d.m).padStart(2, "0") + "-" + String(d.d).padStart(2, "0");
}

function defaultIntakeYear() {
  const now = new Date();
  return now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear();
}

function profileReady(profile) {
  const p = profile || {};
  return Boolean(p.education && p.goal && p.budget);
}

function needsTwelveYears(profile) {
  const p = profile || {};
  return !(p.education === "НИШ / 12 лет" || p.education === "Бакалавр" || p.goal === "Магистратура");
}

const DIPLOMA_DEPENDENT = new Set(["apostille", "translate", "notary", "cimea"]);

const STAGES = [
  {
    id: "start",
    title: "Старт",
    tasks: [
      {
        id: "profile",
        t: "Расскажи о себе",
        explain: "Класс, цель и бюджет нужны, чтобы убрать лишние шаги и поставить задачи в правильном порядке.",
        owner: "Ты",
        time: "~7 мин",
      },
      {
        id: "shortlist",
        t: "Выбрать программы и вузы",
        explain: "Соберём короткий список программ под твои оценки, бюджет и направление.",
        owner: "Ты + IITALY",
        time: "~15 мин",
        ai: true,
        dl: "chooseUni",
      },
      {
        id: "chances",
        t: "Понять шансы на стипендию DSU",
        explain: "DSU — региональная стипендия в Италии. Для предварительной оценки нужны данные о семье и бюджете.",
        owner: "Ты + родители",
        time: "~5 мин",
        ai: true,
      },
    ],
  },
  {
    id: "education12",
    title: "12 лет образования",
    skipIf: (p) => !needsTwelveYears(p),
    tasks: [
      {
        id: "path12",
        t: "Выбрать путь для 12 лет образования",
        explain: "После 11 классов Италии нужен ещё один академический год: можно пройти его в вузе Казахстана или на foundation year.",
        owner: "Ты + родители",
        time: "~10 мин",
        ai: true,
      },
      {
        id: "enroll12",
        t: "Закрыть первый курс в вузе Казахстана",
        explain: "Этот вариант даёт недостающий 12-й год образования до поступления в Италию.",
        owner: "Ты",
        time: "~1 учебный год",
        when: (p) => p.educationPath === "university_kz",
      },
      {
        id: "foundation12",
        t: "Поступить на foundation year и закончить его",
        explain: "Foundation year закрывает недостающий академический год перед бакалавриатом.",
        owner: "Ты + родители",
        time: "~1 учебный год",
        when: (p) => p.educationPath === "foundation",
      },
    ],
  },
  {
    id: "docs",
    title: "Документы",
    tasks: [
      {
        id: "apostille",
        t: "Поставить апостиль на аттестат или диплом",
        explain: "Апостиль подтверждает документ для использования за границей. Его делают на оригинал до перевода.",
        owner: "Ты / родители",
        time: "~1–3 недели",
        dl: "apostille",
        warn: "Сначала оригинал и апостиль, потом перевод.",
      },
      {
        id: "translate",
        t: "Сделать официальный перевод на итальянский",
        explain: "После апостиля документ переводят на итальянский у подходящего переводчика.",
        owner: "Переводчик",
        time: "~3–7 дней",
        dl: "apostille",
      },
      {
        id: "notary",
        t: "Заверить перевод",
        explain: "Для части процедур подпись переводчика нужно заверить у нотариуса.",
        owner: "Нотариус",
        time: "~1 день",
        dl: "apostille",
      },
      {
        id: "cimea",
        t: "Получить признание аттестата через CIMEA",
        explain: "CIMEA подтверждает уровень иностранного образования для части итальянских вузов.",
        owner: "Ты",
        time: "~30–60 дней",
        dl: "cimeaStart",
        note: "Начинай только когда на руках есть финальный документ об образовании.",
      },
      {
        id: "checkDocs",
        t: "Проверить готовые документы",
        explain: "IITALY сверит файл с требованиями шага и покажет, что исправить до подачи.",
        owner: "IITALY",
        time: "~2 мин на файл",
        ai: true,
      },
    ],
  },
  {
    id: "apply",
    title: "Поступление",
    tasks: [
      {
        id: "test",
        t: "Подготовиться и зарегистрироваться на вступительный тест",
        explain: "У программы может быть TOLC, IMAT или собственный тест. Подготовка идёт параллельно с документами.",
        owner: "Ты",
        time: "несколько недель",
        dl: "testReg",
      },
      {
        id: "uniApply",
        t: "Подать заявки в выбранные вузы",
        explain: "У каждого вуза свой портал и свой набор документов.",
        owner: "Ты",
        time: "~30–60 мин на вуз",
        dl: "uniApply",
      },
      {
        id: "universitaly",
        t: "Зарегистрировать поступление на Universitaly",
        explain: "Universitaly — государственный портал Италии для pre-enrolment иностранных студентов перед визой.",
        owner: "Ты",
        time: "~40 мин",
        dl: "universitaly",
        warn: "Без pre-enrolment на Universitaly студенческую визу не оформляют.",
      },
      {
        id: "checkpoint1",
        t: "Проверить пакет перед отправкой",
        explain: "IITALY сверит, что в заявке нет очевидных пропусков перед финальной отправкой.",
        owner: "IITALY",
        time: "~10 мин",
        ai: true,
        dl: "uniApply",
      },
    ],
  },
  {
    id: "dsu",
    title: "Стипендия DSU",
    skipIf: (p) => p.budget === "Без ограничений",
    tasks: [
      {
        id: "familyDocs",
        t: "Собрать семейные справки для DSU",
        explain: "Для стипендии понадобятся документы о составе семьи, доходах и имуществе за нужный референсный период.",
        owner: "Родители",
        time: "~1–3 недели",
        dl: "familyDocs",
      },
      {
        id: "iseeu",
        t: "Оформить показатель дохода для DSU (ISEEU)",
        explain: "ISEEU parificato — итальянский расчёт финансового положения семьи для иностранного студента.",
        owner: "Ты + CAF",
        time: "~1–2 недели",
        dl: "iseeu",
      },
      {
        id: "dsuApply",
        t: "Подать заявку на региональную стипендию",
        explain: "Заявка подаётся в регион, где находится твой университет.",
        owner: "Ты",
        time: "~30 мин",
        dl: "discoDsu",
      },
      {
        id: "checkpoint2",
        t: "Проверить пакет на стипендию",
        explain: "Перед отправкой лучше сверить комплект: ошибка может стоить целого конкурсного года.",
        owner: "IITALY",
        time: "~10 мин",
        ai: true,
        dl: "iseeu",
      },
    ],
  },
  {
    id: "visa",
    title: "Виза",
    tasks: [
      {
        id: "money",
        t: "Подготовить финансовую гарантию",
        explain: "Консульство проверяет, что у студента есть средства на проживание.",
        owner: "Родители",
        time: "начать заранее",
        dl: "money",
      },
      {
        id: "statements",
        t: "Получить банковские выписки",
        explain: "Подготовь выписки в формате, который принимает визовый центр.",
        owner: "Родители",
        time: "~1 день",
        dl: "blsSlot",
      },
      {
        id: "insurance",
        t: "Оформить медицинскую страховку",
        explain: "Страховка входит в визовый пакет.",
        owner: "Ты",
        time: "~30 мин",
        dl: "visaSubmit",
      },
      {
        id: "housing",
        t: "Подтвердить жильё в Италии",
        explain: "Для визы нужно показать, где ты будешь жить.",
        owner: "Ты + родители",
        time: "зависит от жилья",
        dl: "visaSubmit",
      },
      {
        id: "blsSlot",
        t: "Записаться на подачу визы",
        explain: "В высокий сезон свободные слоты быстро заканчиваются.",
        owner: "Ты",
        time: "~15 мин",
        dl: "blsSlot",
      },
      {
        id: "visaSubmit",
        t: "Подать документы на студенческую визу",
        explain: "Финальный визовый пакет подаётся после поступления и Universitaly.",
        owner: "Ты",
        time: "~1 день",
        dl: "visaSubmit",
      },
      {
        id: "checkpoint3",
        t: "Проверить визовый пакет",
        explain: "IITALY сверит комплект перед визовым центром.",
        owner: "IITALY",
        time: "~10 мин",
        ai: true,
        dl: "blsSlot",
      },
    ],
  },
  {
    id: "arrival",
    title: "После приезда",
    tasks: [
      {
        id: "kit",
        t: "Подать на permesso di soggiorno",
        explain: "После въезда студент подаёт пакет на вид на жительство.",
        owner: "Ты",
        time: "~1–2 часа",
        dl: "permesso",
      },
      {
        id: "codice",
        t: "Получить codice fiscale",
        explain: "Итальянский налоговый код нужен для многих бытовых процедур.",
        owner: "Ты",
        time: "~1 день",
        dl: "permesso",
      },
      {
        id: "questura",
        t: "Пройти приём в Questura",
        explain: "На приёме снимают отпечатки для permesso.",
        owner: "Ты",
        time: "~1 день",
        dl: "permesso",
      },
    ],
  },
];

function daysLeft(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  return Math.round((d - today) / 86400000);
}

function buildRoadmap(_tier, profile, intakeYear) {
  const p = profile || {};
  const year = intakeYear || defaultIntakeYear();
  const ready = profileReady(p);
  const school11 = p.education === "11 классов";
  const out = [];

  for (const st of STAGES) {
    if (st.skipIf && st.skipIf(p)) continue;
    const tasks = [];

    for (const t of st.tasks) {
      if (t.when && !t.when(p)) continue;

      let available = true;
      let timingLabel = null;
      let iso = t.dl && ready ? dateFor(t.dl, year) : null;

      if (!ready && t.id !== "profile") {
        available = false;
        iso = null;
        timingLabel = "Сначала закончи настройку маршрута";
      }

      if (school11 && DIPLOMA_DEPENDENT.has(t.id)) {
        available = false;
        iso = null;
        timingLabel = "После получения аттестата";
      }

      tasks.push({
        id: t.id,
        t: t.t,
        explain: t.explain || null,
        owner: t.owner || "Ты",
        time: t.time || null,
        ai: !!t.ai,
        expert: !!t.expert,
        note: t.note || null,
        warn: t.warn || null,
        available,
        timingLabel,
        deadline: iso,
        deadlineKind: iso ? "Ориентир" : null,
        deadlineLabel: iso && t.dl ? DEADLINES[t.dl].label : null,
        daysLeft: iso ? daysLeft(iso) : null,
      });
    }

    if (tasks.length) out.push({ id: st.id, title: st.title, tasks });
  }

  return out;
}

module.exports = {
  buildRoadmap,
  DEADLINES,
  dateFor,
  defaultIntakeYear,
  daysLeft,
  profileReady,
  needsTwelveYears,
};
