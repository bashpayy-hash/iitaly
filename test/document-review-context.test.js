'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDocumentReviewContext, normalizeDocumentResult } = require('../document-review-context');
const review = (profile, academicYear = '2026/27') => buildDocumentReviewContext({profile,academicYear,applicantScope:'kz-family-abroad'});
const issue = (code, rest = {}) => ({code,sourceId:'P26',observed:'Specific observed fact',text:'Issue',fix:'Fix',severity:'critical',...rest});

test('hypothetical package, copy and currency-conversion demands cannot change verdict or actions', () => {
  const parsed = {docType:'bank_statement',bankEvidence:'existing_assets',verdict:'error',summary:'Wrong model conclusion',
    checks:[{code:'legalization',sourceId:'P26',status:'error',label:'Wrong check',note:'Need apostille'}],
    problems:[issue('legalization'),issue('translation'),issue('package_completeness'),issue('currency_conversion'),issue('required_detail',{field:'other_accounts'})],nextSteps:['Buy more documents']};
  const r = normalizeDocumentResult(parsed,review('piemonte'));
  assert.equal(r.verdict,'ok');assert.deepEqual(r.problems,[]);assert.deepEqual(r.nextSteps,[]);assert.deepEqual(r.checks,[]);
  assert(!r.summary.includes('Wrong'));
});

test('an evidenced wrong year survives only for the verified selected institution', () => {
  const parsed = {docType:'bank_statement',problems:[issue('reference_year',{sourceId:'BC26',observed:'31.12.2025 instead of 31.12.2024'})]};
  assert.equal(normalizeDocumentResult(parsed,review('bocconi')).verdict,'error');
  for (const context of [review('bocconi','2027/28'),review('general'),review('piemonte')]) {
    assert.deepEqual(normalizeDocumentResult(parsed,context).problems,[]);
  }
  assert.deepEqual(normalizeDocumentResult({...parsed,problems:[issue('reference_year',{sourceId:'BC26',observed:''})]},review('bocconi')).problems,[]);
});

test('direct content contradictions survive limited scope; Toscana renewal is not presumed first submission', () => {
  const r = normalizeDocumentResult({docType:'salary_certificate',problems:[issue('arithmetic')]},review('general'));
  assert.equal(r.verdict,'error');assert.deepEqual(r.nextSteps,['Fix']);
  const income = {docType:'salary_certificate',applicationKind:'unclear',problems:[issue('document_issue_year',{sourceId:'T26'})]};
  assert.deepEqual(normalizeDocumentResult(income,review('toscana')).problems,[]);
  assert.equal(normalizeDocumentResult({...income,applicationKind:'first_submission'},review('toscana')).verdict,'error');
});

test('visa and unclassified uploads do not inherit scholarship rules', () => {
  for (const doc of [{docType:'other'},{docType:'passport',outOfScope:true},{}]) {
    const r = normalizeDocumentResult({...doc,problems:[issue('legalization',{sourceId:'BC26'})]},review('bocconi'));
    assert.equal(r.review.rulesStatus,'unspecified');assert.equal(r.review.referenceYear,null);
    assert.equal(r.verdict,'warn');assert.deepEqual(r.problems,[]);
  }
});


test('rule compliance cannot bypass source validation as a positive content observation', () => {
  const r = normalizeDocumentResult({docType:'bank_statement',bankEvidence:'existing_assets',checks:[
    {code:'observed_content',sourceId:'M',status:'ok',label:'Route',note:'Unsupported compliance claim'},
    {code:'translation',sourceId:'BC26',status:'ok',label:'Wrong institution',note:'Wrong profile'},
    {code:'observed_content',status:'ok',label:'Currency',note:'KZT is visible'},
    {code:'reference_year',sourceId:'P26',status:'ok',label:'Period',note:'31.12.2025 matches Piemonte'},
  ]},review('piemonte'));
  assert.deepEqual(r.checks.map(c=>c.label),['Currency','Period']);
});
