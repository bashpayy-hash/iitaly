# Document review: official sources and applicability

Audited 13 October 2026 (Europe/Rome). The checker is a preliminary review of one uploaded file, not an eligibility, authenticity, visa or qualification-recognition decision.

## Corrections made

The former knowledge file generalised one student's packet into universal requirements. Its document years and formatting assumptions did not safely apply across scholarship bodies.

| Previous assumption | Current behaviour | Source IDs |
| --- | --- | --- |
| Every 2026/27 application uses 2024 financial data | Bocconi uses 2024; the reviewed non-EU foreign-family profiles for Piemonte, Toscana and ER.GO use 2025 | BC26, P26 Annex E, T26 art. 8.3.2, E26 I.2.3.1 |
| Every bank letter needs EUR conversion at Kazakhstan's central-bank rate | No such universal requirement; apply the institution's local-currency and conversion rules | BC26, P26, E26 |
| Every file needs two apostilles in a fixed order | Determine the recipient's accepted certification route and what each apostille authenticates | M, A, H |
| Every foreign bank document needs Italian translation and legalization | Piemonte's evidence of existing bank assets has a specific language/copy exception; do not extend it to evidence of absence or other documents | P26 Annex E |
| Every certificate expires after 3–6 months | No blanket period; Toscana specifies issue year 2026 with applicable renewal exceptions | T26, T26-R |
| Every income document needs 12 monthly rows | Annual gross evidence and other stated alternatives may be accepted; Bocconi's separate requirements remain separate | BC26, P26, T26-D, E26 |
| Zero bank balance requires another declaration | Zero alone is not an error or proof that other accounts exist or do not exist | Content-only inference, not a new official requirement |
| PDF page count must equal a notarised physical-sheet count | Count only the same identified block and unit; extra translation/notarial pages are not automatically a defect | H and limits of scan evidence |
| One upload proves whether the entire application is complete | Report only observed issues in the file and relevant uncertainty | Product scope |
| Rules can advance a year automatically | New years require a new source audit; Bocconi 2027/28 is marked provisional and other 2027/28 profiles are unverified | B27 |

Exact official URLs are maintained in `knowledge/document-sources.json`. The model's response cannot supply or replace these links. The UI displays the selected application context, source-audit date and limits of the result.

## Applicability contract

Strict profile rules require all three explicit inputs: an allowlisted institution, a verified academic year and `applicantScope=kz-family-abroad`. This scope is a Kazakhstan citizen submitting foreign family income/assets without claiming financial independence. EU citizenship, independent students, mixed Italy/foreign household finances, protection status and other programmes need separate applicability review. A contradictory uploaded document also limits the assessment.

Missing/invalid context stays unspecified. Old clients therefore receive content review, never a silent Bocconi default. `referenceYear` is null for unspecified, provisional and unverified rules. User-provided status, sources and arbitrary text cannot become trusted system context. Review metadata is attached by the server after model parsing. The response also uses a restricted finding-code contract: every retained issue needs an observed fact; rule-based issues need a source from the selected institution. Unverified-year requirements, package-completeness demands, EUR-conversion demands and the Piemonte existing-bank-copy exceptions cannot generate an error or an action. The server derives summaries, verdicts and next steps from retained findings, so speculative model prose cannot override these limits. Out-of-scope documents receive a content-only assessment.

The model still performs probabilistic interpretation: deterministic context and source ownership reduce false rules but do not guarantee error-free judgements. Uploaded documents remain untrusted input. Do not log their contents or use customer files as test fixtures.

## Updating the base

1. Open the institution's new bando, relevant annexes, corrections and document guidance. Verify the non-EU foreign-family branch separately from ordinary ISEE/EU rules.
2. Record the academic year, income/asset reference periods, issue-date rules, accepted alternatives and legalization exceptions. Do not resolve conflicting official text by selecting the stricter interpretation without clarification.
3. Update the relevant profile and source registry together with the knowledge file and audit date. A page labelled as being updated remains provisional. This is a dated snapshot, not live retrieval.
4. Run `node --test test/*.test.js`. The integration tests check actual outbound context, no-context/future-year cases and replacement of model-invented source metadata.
5. Test a small set of synthetic documents for a valid case and a real mismatch in the changed profile. Preserve the mixed-original/translation/notary page-count regression.
6. Rebuild the frontend if adding profile/year choices and pass CI/browser review before publishing.
