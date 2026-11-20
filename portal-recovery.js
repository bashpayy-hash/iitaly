'use strict';

/* «Не помню код»: восстановление кода доступа к кабинету.

   Человек вводит фамилию и телефон, которые указал при покупке. Сервер ищет
   кабинет и отправляет код только туда, куда клиент подключился сам: в
   Telegram-бот и на почту. На экран код не выводится никогда, иначе войти
   мог бы любой, кто знает чужие фамилию и телефон.

   Ответ сайту всегда одинаковый: есть кабинет или нет, подключён ли
   Telegram или почта. По форме нельзя узнать, кто у нас учится. Отправка
   идёт уже после ответа.

   Если кабинет найден, а отправить код некуда или отправка не удалась,
   владельцу приходит сообщение в рабочий чат: код можно переслать в
   WhatsApp вручную, как раньше. */

const RESEND_COOLDOWN_MS = 2 * 60 * 1000;
const SUBJECT = 'IITALY: код доступа к кабинету';

/* +7 777 000 00 00, 8 777 000 00 00 и 7770000000 — один номер.
   Сравниваем последние десять цифр; короче — не телефон. */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits.slice(-10) : '';
}

function findRecoveryMatches({ surname, phone }, { listCodes, readClient, normSurname }) {
  const wantedSurname = normSurname(surname);
  const wantedPhone = phoneKey(phone);
  if (wantedSurname.length < 2 || !wantedPhone) return [];
  const matches = [];
  for (const code of listCodes()) {
    const client = readClient(code);
    if (!client || !client.surname) continue;
    if (normSurname(client.surname) !== wantedSurname) continue;
    if (phoneKey(client.phone) !== wantedPhone) continue;
    matches.push({ code: client.code || code, client });
  }
  return matches;
}

function recoveryText(client, code, siteUrl) {
  const site = String(siteUrl || 'https://iitaly.net').replace(/\/+$/, '');
  return 'IITALY: код доступа к кабинету\n\n'
    + 'Фамилия: ' + client.surname + '\n'
    + 'Код: ' + code + '\n\n'
    + 'Вход: ' + site + '/portal\n\n'
    + 'Код запросили на сайте через «Не помню код». Если это был не ты, ничего делать не нужно: код пришёл только тебе.';
}

function ownerAlertText(client, code) {
  return '🔑 Не помню код\n'
    + [client.surname, client.name].filter(Boolean).join(' ') + '\n'
    + 'Телефон: ' + (client.phone || 'не указан') + '\n'
    + 'Код: ' + code + '\n'
    + 'Telegram и почта не подключены или не ответили. Отправь код в WhatsApp.';
}

/* Один запрос в две минуты на кабинет: форму нельзя превратить в способ
   заваливать чужой Telegram или почту сообщениями. */
function createRecoveryCooldown({ now = () => Date.now(), cooldownMs = RESEND_COOLDOWN_MS } = {}) {
  const last = new Map();
  return {
    allow(code) {
      const t = now();
      for (const [key, at] of last) if (t - at >= cooldownMs) last.delete(key);
      if (last.has(code)) return false;
      last.set(code, t);
      return true;
    },
  };
}

/* Отправка для найденных кабинетов. Каналы передаются снаружи, чтобы модуль
   не знал ни токена бота, ни настроек почты. Возвращает, что куда ушло;
   в журнал сервер пишет только названия каналов, без адресов и кода. */
async function deliverRecovery(matches, { cooldown, siteUrl, sendTelegram, sendEmail, alertOwner }) {
  const results = [];
  for (const { code, client } of matches) {
    if (!cooldown.allow(code)) { results.push({ code, skipped: true, sent: [] }); continue; }
    const text = recoveryText(client, code, siteUrl);
    const sent = [];
    if (client.tgChatId && await sendTelegram(client.tgChatId, text)) sent.push('telegram');
    if (client.email && await sendEmail(client.email, SUBJECT, text)) sent.push('email');
    let ownerAlerted = false;
    if (!sent.length && alertOwner) ownerAlerted = Boolean(await alertOwner(ownerAlertText(client, code)));
    results.push({ code, skipped: false, sent, ownerAlerted });
  }
  return results;
}

module.exports = {
  RESEND_COOLDOWN_MS,
  SUBJECT,
  phoneKey,
  findRecoveryMatches,
  recoveryText,
  ownerAlertText,
  createRecoveryCooldown,
  deliverRecovery,
};
