'use strict';
const registry = require('./knowledge/document-sources.json');
const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

// Only allowlisted choices become system instructions. Neither an uploaded file,
// a legacy hint nor caller-supplied URLs/status can select an unverified rule.
function buildDocumentReviewContext(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const profile = own(registry.profiles, value.profile) ? value.profile : 'general';
  const academicYear = ['2026/27', '2027/28'].includes(value.academicYear) ? value.academicYear : 'unspecified';
  const applicantScope = value.applicantScope === 'kz-family-abroad' ? value.applicantScope : 'unspecified';
  const program = registry.profiles[profile];
  const edition = program && own(program.years, academicYear) ? program.years[academicYear] : null;
  const rulesStatus = profile === 'general' || academicYear === 'unspecified' || applicantScope === 'unspecified'
    ? 'unspecified' : edition?.status || 'unverified';
  const notices = {
    verified: 'Проверка по выбранному профилю: гражданство Казахстана, семейные доходы и имущество за рубежом, без заявления финансовой независимости. Это предварительный разбор одного файла, не решение учреждения.',
    unspecified: 'Программа, учебный год или ситуация не уточнены. Проверяем содержание файла; соответствие требованиям конкретной заявки не подтверждаем.',
    provisional: 'Страница Bocconi 2027/28 ещё обновляется. Проверяем содержание; предварительные положения не используем как основание для отказа.',
    unverified: 'Для выбранного учебного года правила этой программы в базе ещё не подтверждены. Проверяем содержание, без строгого вердикта по году доходов и оформлению.',
  };
  const sourceIds = [...(edition?.sourceIds || []), 'M', 'A', 'H'];
  return {
    profile,
    profileLabel: program?.label || 'Общая проверка',
    academicYear,
    applicantScope,
    rulesStatus,
    referenceYear: rulesStatus === 'verified' ? edition.referenceYear : null,
    rulesVersion: registry.version,
    verifiedOn: registry.verifiedOn,
    notice: notices[rulesStatus],
    sources: sourceIds.map(id => ({ id, ...registry.sources[id] })),
  };
}

function documentContextPrompt(review) {
  return '\n\n=== СЕРВЕРНЫЙ КОНТЕКСТ ПРОВЕРКИ ===\n'
    + JSON.stringify(review)
    + '\nПрименяй только выбранный профиль. Положения других учреждений не переносятся на него. '
    + 'referenceYear=null запрещает назначать год доходов/активов по умолчанию. '
    + 'Даже verified не распространяется на визы, признание аттестатов или иные типы заявок. '
    + 'Если содержимое показывает иную ситуацию, обозначь пределы проверки вместо применения неподходящих правил.';
}

const factualCodes = new Set(['required_detail', 'arithmetic', 'inconsistent_details', 'missing_scan', 'unreadable']);
const requiredFields = new Set(['holder', 'currency', 'amount', 'period', 'issuer', 'area', 'ownership', 'family_members']);
const financialTypes = new Set(['bank_statement', 'salary_certificate', 'income_ip', 'property_certificate']);

// A model may describe uncertainty, but cannot promote a hypothetical rule or
// a missing *other* document to an error in this upload. Unknown codes fail closed.
function normalizeDocumentResult(parsed, review) {
  const scholarshipTypes = new Set(['passport', 'birth_certificate', 'family_composition', 'salary_certificate', 'income_ip', 'property_certificate', 'bank_statement', 'notary_translation', 'apostille', 'university_certificate', 'isu_application', 'declaration_no_business']);
  if (parsed.outOfScope === true || !scholarshipTypes.has(parsed.docType)) {
    review = { ...review, rulesStatus: 'unspecified', referenceYear: null,
      notice: 'Для этого типа или назначения документа стипендиальные правила не применены. Доступна только проверка видимого содержания.' };
  }
  const bankCopyException = review.profile === 'piemonte' && parsed.docType === 'bank_statement'
    && parsed.bankEvidence === 'existing_assets';
  const allowed = item => {
    if (!item || typeof item !== 'object') return false;
    if (factualCodes.has(item.code)) {
      return item.code !== 'required_detail' || requiredFields.has(item.field);
    }
    if (review.rulesStatus !== 'verified' || !review.sources.some(s => s.id === item.sourceId && !['M', 'A', 'H'].includes(s.id))) return false;
    if (item.code === 'reference_year') return financialTypes.has(parsed.docType);
    if (item.code === 'document_issue_year') return review.profile === 'toscana' && parsed.applicationKind === 'first_submission';
    if (item.code === 'income_gross') return ['salary_certificate', 'income_ip'].includes(parsed.docType);
    if (item.code === 'local_currency') return ['piemonte', 'ergo'].includes(review.profile) && financialTypes.has(parsed.docType);
    if (['translation', 'legalization'].includes(item.code)) {
      return !bankCopyException && ['bank_statement', 'salary_certificate', 'income_ip', 'property_certificate', 'family_composition', 'birth_certificate'].includes(parsed.docType)
        && !(review.profile === 'piemonte' && parsed.docType === 'bank_statement' && parsed.bankEvidence !== 'absence_of_assets');
    }
    return false;
  };
  const problems = (Array.isArray(parsed.problems) ? parsed.problems : [])
    .filter(p => allowed(p) && typeof p.observed === 'string' && p.observed.trim()
      && typeof p.text === 'string' && p.text.trim())
    .slice(0, 6).map(p => ({ ...p, severity: p.severity === 'critical' ? 'critical' : 'minor' }));
  const checks = (Array.isArray(parsed.checks) ? parsed.checks : []).filter(c => {
    if (!c || typeof c.label !== 'string' || typeof c.note !== 'string') return false;
    if (c.code === 'observed_content') return c.status === 'ok' && !c.sourceId;
    if (!allowed(c)) return false;
    return c.status === 'ok' || (['warn', 'error'].includes(c.status) && problems.some(p => p.code === c.code));
  }).slice(0, 6);
  const verdict = parsed.docType === 'unreadable' ? 'unreadable'
    : problems.some(p => p.severity === 'critical') ? 'error'
    : problems.length || review.rulesStatus !== 'verified' ? 'warn' : 'ok';
  const summaries = {
    unreadable: 'Не удалось прочитать необходимые сведения. Пришли более чёткий скан.',
    error: 'Найдено конкретное несоответствие. Ниже — что видно в документе и что нужно исправить.',
    warn: problems.length ? 'Есть замечания к видимому содержанию. Основания и действия указаны ниже.'
      : 'Видимых ошибок в содержании не найдено. Соответствие требованиям заявки пока не подтверждено.',
    ok: 'В пределах выбранного профиля видимых ошибок не найдено. Это не подтверждение подлинности или принятия документа.',
  };
  const nextSteps = [...new Set(problems.map(p => p.fix).filter(f => typeof f === 'string' && f.trim()))].slice(0, 3);
  if (!nextSteps.length && verdict === 'unreadable') nextSteps.push('Пришли более чёткий скан или фото нужных страниц.');
  else if (!nextSteps.length && review.rulesStatus !== 'verified') nextSteps.push(review.rulesStatus === 'unspecified'
    ? 'Уточни программу, учебный год и ситуацию заявителя для проверки требований.'
    : 'Сверь окончательные требования выбранного года с учреждением: в этой базе они ещё не подтверждены.');
  return { ...parsed, verdict, summary: summaries[verdict], checks, problems, nextSteps, review };
}

module.exports = { buildDocumentReviewContext, documentContextPrompt, normalizeDocumentResult };
