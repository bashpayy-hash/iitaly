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

module.exports = { buildDocumentReviewContext, documentContextPrompt };
