'use strict';

const { buildDocumentReviewContext } = require('./document-review-context');

// This is a storage boundary, not another AI/rules evaluation. Re-running the
// normalizer here could reinterpret a historical report or upgrade its verdict.
// The authenticated client supplies this report; persistence is not a signed
// attestation that /api/check-document produced it.
const LIMITS = Object.freeze({ checks: 6, problems: 6, nextSteps: 3, sources: 8,
  titleBytes: 160, summaryBytes: 2000, labelBytes: 160, noteBytes: 600,
  findingBytes: 800, observedBytes: 1000, noticeBytes: 1000 });
const VERDICTS = new Set(['ok', 'warn', 'error', 'unreadable']);
const STATUSES = new Set(['ok', 'warn', 'error', 'unknown']);
const RULE_STATUSES = new Set(['verified', 'unspecified', 'provisional', 'unverified']);
const DOC_TYPES = new Set(['passport', 'birth_certificate', 'family_composition', 'salary_certificate',
  'income_ip', 'property_certificate', 'bank_statement', 'notary_translation', 'apostille',
  'university_certificate', 'isu_application', 'declaration_no_business', 'other', 'unreadable']);
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function text(value, maxBytes) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= maxBytes) return clean;
  // Back up to a UTF-8 boundary instead of persisting a replacement character.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8').trimEnd();
}

function token(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(value) ? value : undefined;
}

function reviewSnapshot(value, outOfScope) {
  if (!record(value)) return undefined;
  const verifiedOn = text(value.verifiedOn, 10);
  const rulesVersion = text(value.rulesVersion, 64);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn) || !rulesVersion) return undefined;
  const canonical = buildDocumentReviewContext(value);
  let rulesStatus = RULE_STATUSES.has(value.rulesStatus) ? value.rulesStatus : 'unspecified';
  if (rulesStatus === 'verified' && canonical.rulesStatus !== 'verified') rulesStatus = canonical.rulesStatus;
  if (outOfScope || (rulesStatus === 'verified' && value.referenceYear !== canonical.referenceYear)) rulesStatus = 'unspecified';
  const allowedSources = new Map(canonical.sources.map(source => [source.id, source]));
  const seen = new Set();
  const sources = [];
  for (const source of Array.isArray(value.sources) ? value.sources : []) {
    if (!record(source) || !allowedSources.has(source.id) || seen.has(source.id)) continue;
    seen.add(source.id);
    // URLs and labels come only from the maintained server registry, never from
    // the submitted payload. Keep the submitted audit date/version unchanged.
    sources.push({ ...allowedSources.get(source.id) });
    if (sources.length === LIMITS.sources) break;
  }
  return {
    profile: canonical.profile,
    profileLabel: canonical.profileLabel,
    academicYear: canonical.academicYear,
    applicantScope: canonical.applicantScope,
    rulesStatus,
    referenceYear: rulesStatus === 'verified' ? canonical.referenceYear : null,
    rulesVersion,
    verifiedOn,
    notice: rulesStatus === value.rulesStatus
      ? text(value.notice, LIMITS.noticeBytes)
      : buildDocumentReviewContext({}).notice,
    sources,
  };
}

function evidenceFields(value, sourceIds) {
  const fields = {};
  for (const key of ['code', 'field']) {
    const safe = token(value[key]);
    if (safe) fields[key] = safe;
  }
  if (sourceIds.has(value.sourceId)) fields.sourceId = value.sourceId;
  const observed = text(value.observed, LIMITS.observedBytes);
  if (observed) fields.observed = observed;
  return fields;
}

function sanitizePortalDocumentResult(input) {
  if (!record(input)) return null;
  const review = reviewSnapshot(input.review, input.outOfScope === true);
  const sourceIds = new Set(review?.sources.map(source => source.id) || []);
  const reportedChecks = (Array.isArray(input.checks) ? input.checks : []).filter(record);
  const checks = reportedChecks
    .filter(value => typeof value.label === 'string' && value.label.trim())
    .slice(0, LIMITS.checks).map(value => ({
      status: STATUSES.has(value.status) ? value.status : 'unknown',
      label: text(value.label, LIMITS.labelBytes),
      note: text(value.note, LIMITS.noteBytes),
      ...evidenceFields(value, sourceIds),
    }));
  let findings = (Array.isArray(input.problems) ? input.problems : []).filter(record)
    .filter(value => typeof value.text === 'string' && value.text.trim());
  if (findings.length > LIMITS.problems) {
    // An oversized client list must not hide a critical finding after the cap.
    findings = [...findings.filter(value => value.severity === 'critical'), ...findings.filter(value => value.severity !== 'critical')];
  }
  const problems = findings.slice(0, LIMITS.problems).map(value => ({
    severity: value.severity === 'critical' ? 'critical' : 'minor',
    text: text(value.text, LIMITS.findingBytes),
    fix: text(value.fix, LIMITS.findingBytes),
    ...evidenceFields(value, sourceIds),
  }));
  const nextSteps = (Array.isArray(input.nextSteps) ? input.nextSteps : [])
    .filter(value => typeof value === 'string' && value.trim()).slice(0, LIMITS.nextSteps)
    .map(value => text(value, LIMITS.findingBytes));

  let verdict = VERDICTS.has(input.verdict) ? input.verdict : 'warn';
  // Keep limited/unknown reports limited. Conflicting client fields cannot
  // complete a task, but removing invalid fields must never upgrade a report.
  if (verdict === 'ok' && input.docType === 'unreadable') verdict = 'unreadable';
  if (verdict === 'ok' && (problems.length || reportedChecks.some(check => check.status !== 'ok')
    || input.docType === 'other' || input.outOfScope === true || (input.review !== undefined && (!review || review.rulesStatus !== 'verified')))) {
    verdict = problems.some(problem => problem.severity === 'critical') ? 'error' : 'warn';
  }
  const result = {
    verdict,
    docTitle: text(input.docTitle, LIMITS.titleBytes) || 'Документ',
    summary: text(input.summary, LIMITS.summaryBytes),
    checks,
    problems,
    nextSteps,
  };
  if (DOC_TYPES.has(input.docType)) result.docType = input.docType;
  if (typeof input.outOfScope === 'boolean') result.outOfScope = input.outOfScope;
  if (['existing_assets', 'absence_of_assets', 'unclear'].includes(input.bankEvidence)) result.bankEvidence = input.bankEvidence;
  if (['first_submission', 'renewal', 'unclear'].includes(input.applicationKind)) result.applicationKind = input.applicationKind;
  if (review) result.review = review;
  return result;
}

module.exports = { sanitizePortalDocumentResult, LIMITS };
