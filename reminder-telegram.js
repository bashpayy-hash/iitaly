'use strict';

/** Provider acceptance, not a device delivery/read receipt. Never log the URL:
 * the Telegram bot token is part of it. No retry sleeps inside HTTP handlers. */
async function sendTelegramReminder(token, chatId, text, fetchImpl = globalThis.fetch, timeoutMs = 15000) {
  if (!token || !chatId) return { ok: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }), signal: controller.signal,
    });
    const body = await response.json();
    if (response.ok && body && body.ok === true && Number.isInteger(body.result?.message_id)) {
      return { ok: true };
    }
    const seconds = Number(body?.parameters?.retry_after);
    const code = Number(body?.error_code || response.status);
    return {
      ok: false,
      rateLimited: code === 429,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) * 1000
        : [400, 401, 403, 404].includes(code) ? 24 * 60 * 60 * 1000 : 0,
    };
  } catch { return { ok: false }; }
  finally { clearTimeout(timeout); }
}

module.exports = { sendTelegramReminder };
