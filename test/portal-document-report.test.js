'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDocumentReviewContext, normalizeDocumentResult } = require('../document-review-context');
const { sanitizePortalDocumentResult, LIMITS } = require('../portal-document-report');

const review = () => buildDocumentReviewContext({ profile: 'bocconi', academicYear: '2026/27', applicantScope: 'kz-family-abroad' });
const issue = (extra = {}) => ({ severity: 'critical', code: 'reference_year', sourceId: 'BC26',
  observed: 'На выписке указано 31.12.2025.', text: 'Год выписки не совпадает с требованиями заявки.',
  fix: 'Закажи выписку на 31.12.2024.', ...extra });

test('storage preserves the complete normalized report and its evidence without evaluating it again', () => {
  const normalized = normalizeDocumentResult({ docType: 'bank_statement', docTitle: 'Банковская выписка',
    bankEvidence: 'existing_assets', applicationKind: 'first_submission', outOfScope: false,
    checks: [{ status: 'error', code: 'reference_year', sourceId: 'BC26', label: 'Год выписки', note: 'Указан 2025 вместо 2024.' }],
    problems: [issue({ field: 'period' })] }, review());
  const stored = sanitizePortalDocumentResult(normalized);
  assert.deepEqual(stored, normalized);
  assert.equal(stored.problems[0].observed, 'На выписке указано 31.12.2025.');
  const historical = { ...normalized, review: { ...normalized.review, verifiedOn: '2026-09-20', rulesVersion: 'historical-snapshot' } };
  assert.deepEqual(sanitizePortalDocumentResult(historical).review, historical.review, 'Storage must not stamp an old report as audited today');
});

test('storage keeps limited/error results conservative, including unknown verdicts and inconsistent ok payloads', () => {
  for (const verdict of ['warn', 'error', 'unreadable']) {
    assert.equal(sanitizePortalDocumentResult({ verdict, review: review(), problems: [] }).verdict, verdict);
  }
  assert.equal(sanitizePortalDocumentResult({ verdict: 'approved' }).verdict, 'warn');
  assert.equal(sanitizePortalDocumentResult({}).verdict, 'warn');
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', problems: [issue()] }).verdict, 'error');
  const limited = { ...review(), rulesStatus: 'unspecified', referenceYear: null, notice: 'Стипендиальные правила здесь неприменимы.' };
  const stored = sanitizePortalDocumentResult({ verdict: 'warn', outOfScope: true, review: limited });
  assert.deepEqual(stored.review, limited, 'A selected verified programme does not override an out-of-scope result');
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', review: limited }).verdict, 'warn');
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', review: { rulesStatus: 'verified' } }).verdict, 'warn');
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', docType: 'unreadable', review: review() }).verdict, 'unreadable');
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', docType: 'other', review: review() }).verdict, 'warn');
  const oversizedChecks = [...Array.from({ length: 6 }, () => ({ status: 'ok', label: 'Passed' })), { status: 'unknown', label: 'Uncertain' }];
  assert.equal(sanitizePortalDocumentResult({ verdict: 'ok', checks: oversizedChecks }).verdict, 'warn', 'Trimming a check must not promote uncertainty to approval');
});

test('storage rejects non-object reports and copies no raw files, arbitrary properties or client-controlled source links', () => {
  for (const input of [null, [], 'report', 7]) assert.equal(sanitizePortalDocumentResult(input), null);
  const input = JSON.parse('{"__proto__":{"polluted":true},"pdf":"RAW_FILE_SENTINEL"}');
  Object.assign(input, { verdict: 'error', image: 'RAW_FILE_SENTINEL', fileName: 'RAW_FILE_SENTINEL',
    review: { ...review(), sources: [{ id: 'BC26', label: 'Forged label', url: 'javascript:alert(1)' },
      { id: 'E26', url: 'https://example.invalid/unrelated' }, { id: 'invented', url: 'https://example.invalid' }] },
    problems: [issue({ file: 'RAW_FILE_SENTINEL', sourceId: 'invented' })],
    checks: [{ label: 'Currency', note: 'KZT', status: 'ok', pdf: 'RAW_FILE_SENTINEL' }],
  });
  const stored = sanitizePortalDocumentResult(input);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /RAW_FILE_SENTINEL|javascript:|example\.invalid|polluted|Forged label/);
  assert.deepEqual(stored.review.sources, review().sources.filter(source => source.id === 'BC26'));
  assert.equal(stored.problems[0].sourceId, undefined);
  assert.equal(stored.verdict, 'error', 'Dropping an invalid source does not approve the file');
  assert.equal({}.polluted, undefined);
});

test('storage bounds multibyte content and prioritizes critical findings beyond the normal model limits', () => {
  const huge = '🧾'.repeat(20000) + '\u0000';
  const input = { verdict: 'error', docTitle: huge, summary: huge,
    checks: Array.from({ length: 20 }, () => ({ label: huge, note: huge, observed: huge, status: 'error', code: 'arithmetic' })),
    problems: [...Array.from({ length: 20 }, () => issue({ severity: 'minor', text: huge, fix: huge, observed: huge })),
      issue({ text: 'Critical finding at the end', fix: huge, observed: huge })],
    nextSteps: Array(20).fill(huge), review: { ...review(), notice: huge } };
  const stored = sanitizePortalDocumentResult(input);
  assert.equal(stored.checks.length, LIMITS.checks);
  assert.equal(stored.problems.length, LIMITS.problems);
  assert.equal(stored.nextSteps.length, LIMITS.nextSteps);
  assert.equal(stored.problems[0].text, 'Critical finding at the end');
  assert.equal(stored.problems[0].severity, 'critical');
  assert(Buffer.byteLength(stored.summary) <= LIMITS.summaryBytes);
  assert(Buffer.byteLength(stored.problems[1].observed) <= LIMITS.observedBytes);
  const serialized = JSON.stringify(stored);
  assert(Buffer.byteLength(serialized) < 48 * 1024, 'A stored report stays below 48 KiB even with multibyte text');
  assert.doesNotMatch(serialized, /\ufffd|\\u0000/);
});
