'use strict';
// Operational readiness check, distinct from isolated CI tests with fake keys.
// No document, customer data, or generated message is sent.
(async () => {
  if (!process.env.BASE) throw new Error('Set BASE to the backend origin.');
  const base = new URL(process.env.BASE);
  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid BASE protocol');
  const response = await fetch(new URL('/health/ai', base), { signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  const ready = response.ok && data.ok === true && data.code === 'AI_READY';
  console.log(JSON.stringify({ ready, httpStatus: response.status, code: data.code, checkedAt: data.checkedAt }));
  process.exitCode = ready ? 0 : 1;
})().catch(() => { console.error('AI readiness could not be verified'); process.exitCode = 1; });
