'use strict';

// Never expose the key (or provider response body) through logs or health routes.
function normalizeApiKey(value) {
  let key = typeof value === 'string' ? value.trim() : '';
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

const CONFIG_ERRORS = {
  401: 'AI_AUTH_INVALID',
  403: 'AI_PERMISSION_DENIED',
  404: 'AI_MODEL_UNAVAILABLE',
};
const ADMIN_MESSAGE = 'ИИ-проверка временно отключена: требуется исправление настроек сервиса. Повторная отправка файла не поможет. Гайды доступны без ИИ.';

function createAiReadiness({ apiKey, model, request, now = Date.now, ttlMs = 60000, onChange = () => {} }) {
  let state = { ok: false, code: 'AI_NOT_CHECKED', retryable: true, checkedAt: null };
  let expires = 0, pending = null, revision = 0;
  function publish(ok, code, retryable, ttl = ttlMs) {
    const changed = state.code !== code;
    state = { ok, code, retryable, checkedAt: new Date(now()).toISOString(),
      ...(ok ? {} : { error: retryable ? 'Не удалось подтвердить доступность ИИ. Проверь доступность ещё раз чуть позже.' : ADMIN_MESSAGE }) };
    expires = now() + ttl;
    if (changed) onChange({ ok, code });
    return { ...state };
  }
  function recordFailure(status) {
    const code = CONFIG_ERRORS[status];
    if (!code) return null;
    revision++;
    return publish(false, code, false);
  }
  async function check() {
    if (expires > now()) return { ...state };
    if (pending) return pending;
    if (!apiKey) return publish(false, 'AI_KEY_MISSING', false);
    if (/[\s\x00-\x1f\x7f]/.test(apiKey)) return publish(false, 'AI_KEY_FORMAT', false);
    const startedAtRevision = revision;
    pending = (async () => {
      try {
        // Metadata only: no user document or generated answer in this probe.
        const response = await request('https://api.anthropic.com/v1/models/' + encodeURIComponent(model), {
          method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        });
        if (revision !== startedAtRevision) return { ...state };
        if (!response.ok) return publish(false, CONFIG_ERRORS[response.status] || 'AI_PROVIDER_UNAVAILABLE', !CONFIG_ERRORS[response.status]);
        const data = await response.json();
        if (revision !== startedAtRevision) return { ...state };
        if (data?.type !== 'model' || typeof data.id !== 'string') return publish(false, 'AI_PROVIDER_UNAVAILABLE', true);
        return publish(true, 'AI_READY', true);
      } catch {
        if (revision !== startedAtRevision) return { ...state };
        return publish(false, 'AI_PROVIDER_UNAVAILABLE', true);
      }
    })();
    try { return await pending; } finally { pending = null; }
  }
  return { check, recordFailure, snapshot: () => ({ ...state }) };
}

module.exports = { normalizeApiKey, createAiReadiness };
