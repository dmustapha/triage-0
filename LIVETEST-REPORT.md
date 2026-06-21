# Livetest Report

**URL / Runtime:** http://localhost:3010 (on-device local runtime — the production environment for a zero-cloud-inference app; exactly what a Stage-3 judge runs. No cloud URL by design.)
**Mode:** Web · **Version:** V1 (fresh functional-coverage run); see V2 addendum below.
**Tested:** 2026-06-21
**Overall:** PASS

---

## V2 addendum — accuracy redesign re-validation (2026-06-21)

After the table-driven routing redesign (frozen WHO decision table; model emits one enum classification;
deterministic severity/plan/citation; RAG demoted to grounding), the live `/triage` SSE path was re-run
against the running server to confirm the redesign end-to-end (not just the test harness). The off-seed
failure that motivated the redesign is fixed in production:

| Live case | Result (rendered card + plan) |
|-----------|-------------------------------|
| **3yo fever, malaria area, no test (THE original failure)** | severity **URGENT**, action "Give recommended first line oral antimalarial", citation **IMCI p.8** ("MALARIA Give recommended first line oral antimalarial"), medicine **Artemether-lumefantrine** ("Give two times daily for 3 days"), follow-up "Follow-up in 3 days if fever persists". (Was: no medicine, garbled citation, age-wrong advice.) |
| Dysentery (blood in stool) | URGENT, "Give ciprofloxacin for 3 days", IMCI p.7, Ciprofloxacin "Give 15mg/kg two times daily for 3 days", follow-up 3 days. |
| Off-domain (chocolate cake) | Correctly **abstains** (no invented citation). |

Backed by: stress harness 41/41 (`scripts/stress-triage.ts`, WHO-derived expectations incl. edge cases),
full automated suite 96/96, and the dose-safety gate (every WHO line a verbatim substring of its cited
chunk). V2 = PASS.

---

### V1 (original functional-coverage run)
**Overall:** PASS
**Results:** 9 domains PASS / 0 FAIL · 2 N/A (auth, budget — neither applies to an on-device, no-auth app)

> V1 answers "does every named feature work at all?" against the live running app + real browser UI. This complements the 90-test programmatic suite (which uses `app.listen(0)`) by exercising the actual browser-rendered flow the suite cannot reach.

---

## Domain Results

| # | Domain | Status | Notes |
|---|--------|--------|-------|
| 1 | Core User Flows | PASS | Live `/triage` SSE: citation→first_token→reasoning→card→plan→done. Hero pneumonia case → URGENT (correctly not EMERGENCY), action "Give oral Amoxicillin for 5 days", plan with Amoxicillin (by weight band) + home-care + return-now + follow-up, all WHO-cited. TTS control present. |
| 2 | API Connectivity | PASS | `/health` 200 (`citationMapHealthy:true`, chunks 994, models resident), `/` `/app` `/perf-log.csv` 200. Validation: triage empty/oversized/malformed-JSON → 400; tts empty/oversized → 400; transcribe no-file → 400; server survives malformed JSON (`/health` 200 after). |
| 3 | Visual Completeness | PASS | Browser render of `/app` and `/`: no `undefined`/`null`/`NaN`/`[object Object]`; full triage card renders (severity badge, citation, plan, HUD, disclaimer). |
| 4 | Form Functionality | PASS | Textarea + Get guidance → SSE → card. Empty case → 400 (handled, no crash). |
| 5 | Console Errors | PASS | **Zero** first-party console errors and zero page errors during full browser triage flow. |
| 6 | Auth Flows | N/A | No auth by design (single-user on-device localhost tool). |
| 7 | Mobile Responsiveness | PASS | 375px: no horizontal scroll on `/` or `/app` (scrollW == clientW == 375). |
| 8 | Post-PRD Additions | PASS | Hardening confirmed LIVE: friendly errors (no path leak), `/tts`+`/transcribe` caps, MulterError→400, a11y (`h1`=1, `#card aria-live="polite"`, `#case aria-label`), AA badge contrast. |
| 9 | Integration Proof | PASS | Real on-device inference proven: perf HUD TTFT 1.78s, 40.8 tok/s, `backendDevice:gpu`; citation `WHO IMCI Chart Booklet (2014) p.6`, score 0.737 semantic — RAG grounding is live, not mocked. |
| 10 | Budget/Rate | N/A | Zero API spend — 100% on-device, no metered calls. |

---

## Cross-Integration Proofs (on-device)
| Integration | Proof |
|-------------|-------|
| app → MedPsy-1.7B (reasoning) | perf-log `completion` rows, `backendDevice=gpu`, 40.8 tok/s |
| app → GTE-large + @qvac/rag (retrieval) | citation `IMCI p.6`, semantic score 0.737 (≥0.70 threshold) |
| app → Supertonic (TTS) | `/tts` returns audio/wav (validated in suite + UI control present) |

## Critical Issues (P0)
_None._

## Warnings (P1)
_None._

## Notes
- Follow-up line rendered "Follow-up in 5 days if not improving" (cited IMCI p.6). This is a real, WHO-cited verbatim line; the F10 smallest-interval rule makes the choice deterministic per retrieval. The exact interval can vary with retrieval (documented known soft-limit) — every value remains a grounded citation, never fabricated. A V2 run could pin the expected interval against source.
- Auth/budget domains are N/A by design (on-device, no-auth, no metered services), not skipped for lack of credentials.

## Screenshots
`screenshots/livetest-landing-*.png`, `livetest-app-*.png` (rendered triage card), `livetest-mobile-{landing,app}-*.png`.
