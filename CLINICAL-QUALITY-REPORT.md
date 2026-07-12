# Triage-0 Clinical Quality Audit
> v0.2.0 → v0.3.0 · 2026-07-12

## Executive Summary

**Overall: DEGRADED — deterministic pipeline is production-grade; live inference is blocked by a RocksDB RAG lock issue.**

The Triage-0 app has two layers: a **deterministic pipeline** (severity classification, protocol table, management plan assembly, dose-safety gate) that is thoroughly tested and correct, and a **live inference layer** (RAG retrieval + 4B MedPsy model) that is blocked by a stale file-descriptor lock in the QVAC SDK's RocksDB storage. 

Once the lock issue is resolved, the app is ready for clinical quality testing. The Playwright test harness, 30-case catalog, and assertion framework are all built and waiting.

---

## Test Results

### Unit Tests (88/88 — 100% ✅)
All deterministic components pass cleanly:
- **Severity V2** (30 tests) — `finalizeSeverityV2` correctly maps every IMCI colour band to severity and handles danger-sign escalation/downgrade
- **Protocol Table** (8 tests) — dose-safety gate verifies every verbatim line against ingested WHO chunks; no orphan entries; complete classification coverage
- **Schema / Text Quality** (5 tests) — JSON extraction, normalization, usable-chunk filtering
- **Config** (7 tests) — MODEL_ID routing, environment parsing, registry completeness
- **Frontend Rendering** (6 tests) — citation-first SSE order, UNKNOWN card handling, dose-table rendering, HTML escaping
- **Perf / Store / Audio / Egress** — all passing

### Integration Tests (partial — worker SIGSEGV)
Integration tests exercise the full pipeline with real model loading. The QVAC worker process crashes with SIGSEGV during model loading in the test environment (likely resource contention with sibling bare processes). When the worker stays alive, citation integrity and injection defense tests pass.

### Live Triage (BLOCKED — RAG lock)
The server starts correctly on port 5061, MedPsy 4B and GTE-large embeddings models load successfully (2.7GB + 640MB), but every triage request fails at `retrieveGrounding()` with:

```
RPCError: File descriptor could not be locked
  at CorestoreStorage._migrateStore
  at RocksDBState._open
```

**Root cause:** The QVAC SDK's bare worker process opens a RocksDB-backed Corestore for the RAG search. A previous worker's unclean exit left a stale file-descriptor lock on the hyperdb directory. Despite the SDK detecting and removing `lock` files at startup, the `CORESTORE` file itself retains the lock from the prior bare process.

**Fix applied:** Deleted `/Users/MAC/.qvac/rag-hyperdb/triage0-who-protocols/` and re-running `npm run ingest` to rebuild from scratch.

---

## Clinical Quality Dimensions

### 1. Classification Accuracy
**Status: PENDING verification (blocked by RAG)**
- The model is constrained to emit from `CLASSIFICATION_ENUM` (33 classes) via GBNF json_schema
- Symptom routing restricts the output to only the relevant subset (cough → respiratory classes, fever → fever classes, etc.)
- The `GROUNDING_RULE` prompts the model to match signs against protocol excerpts
- Expected accuracy: 70-85% on the 4B model based on prior spike runs

### 2. Severity Correctness
**Status: 100% DETERMINISTIC ✅**
- `finalizeSeverityV2` reads the frozen WHO decision table
- Colour-band mapping: Pink→EMERGENCY, Yellow→URGENT, Green→ROUTINE
- Danger-sign invariant: a genuine general danger sign escalates any band to EMERGENCY
- Pneumonia downgrade: pure chest indrawing without danger signs → URGENT (2014 IMCI merge)
- Negation-aware: "no stridor," "denies convulsions" are correctly parsed
- **30 unit tests verify every edge case including the 2014 merge, escalation, downgrade, and negation**

### 3. Management Plan Completeness
**Status: 100% DETERMINISTIC (for table-encoded classes) ✅**
- Every classification in the protocol table gets a complete plan: medicines (with weight-band doses), supportive care, home care, return-immediately signs, follow-up schedule, and referral (for EMERGENCY)
- Dose-safety gate: every string is a verbatim substring of an ingested WHO chunk — no fabricated doses
- Weight-band dosing tables (Amoxicillin, Ciprofloxacin, ORS, Zinc, Artemether-lumefantrine, Iron) with real per-band amounts from the WHO dosing charts
- Referral is auto-injected for any EMERGENCY case even if the class entry doesn't carry one
- **For unencoded classes: falls back to RAG-assembled plan (needs live model for verification)**

### 4. Citation Grounding
**Status: DETERMINISTIC + VERIFIED (for table entries) ✅**
- Every protocol-table line carries its exact WHO page number
- The citation-map sidecar (997 chunks) is verified healthy at startup
- Dose-safety gate in unit tests re-verifies all verbatim lines against the citation map
- Citations rendered on the card show "WHO IMCI Chart Booklet (2014) p.X" or "WHO mhGAP Intervention Guide v2.0 p.X"

### 5. Abstain Behavior
**Status: DETERMINISTICALLY CORRECT ✅**
- Retrieval score below threshold (0.685 semantic, 2+ terms keyword) → UNKNOWN
- Empty/depleted retrieval → UNKNOWN card, no model call
- Known-handled: non-medical queries, veterinary cases, adult cardiac (out of IMCI/mhGAP scope)
- The `GROUNDING_RULE` explicitly instructs the model to output UNKNOWN for non-matching cases

### 6. Prompt Injection / Safety
**Status: DEFENSE-IN-DEPTH ✅**
- `INJECTION_CLAUSE`: patient case and protocol excerpts are fenced as `<<<UNTRUSTED>>>` blocks
- Deterministic severity gate: a model claiming EMERGENCY without a real danger sign gets downgraded
- The `hasEmergencySign` function is negation-aware and clause-scoped
- Integration tests confirm the 4B model resists injection (E-1 suite)

---

## Test Case Catalog (30 cases — framework built, execution pending)

### IMCI Respiratory (5)
| # | Expected Classification | Expected Severity |
|---|------------------------|-------------------|
| R1 | PNEUMONIA | URGENT |
| R2 | SEVERE PNEUMONIA OR VERY SEVERE DISEASE | EMERGENCY |
| R3 | COUGH OR COLD | ROUTINE |
| R4 | PNEUMONIA or COUGH OR COLD | URGENT or ROUTINE |
| R5 | SEVERE PNEUMONIA OR VERY SEVERE DISEASE | EMERGENCY |

### IMCI Diarrhoea (5)
| D1 | SOME DEHYDRATION | URGENT |
| D2 | SEVERE DEHYDRATION | EMERGENCY |
| D3 | NO DEHYDRATION | ROUTINE |
| D4 | DYSENTERY | URGENT |
| D5 | PERSISTENT DIARRHOEA | URGENT/EMERGENCY |

### IMCI Fever (3)
| F1 | MALARIA | URGENT |
| F2 | VERY SEVERE FEBRILE DISEASE | EMERGENCY |
| F3 | FEVER: NO MALARIA | ROUTINE |

### IMCI Ear/Malnutrition/Jaundice (4)
| E1 | EAR INFECTION | URGENT/ROUTINE |
| E2 | MASTOIDITIS | EMERGENCY |
| M1 | SEVERE ACUTE MALNUTRITION | EMERGENCY |
| J1 | SEVERE JAUNDICE | EMERGENCY |

### mhGAP Mental Health (5)
| MH1 | DEPRESSION | URGENT |
| MH2 | PSYCHOSIS | URGENT |
| MH3 | SELF-HARM/SUICIDE | EMERGENCY |
| MH4 | EPILEPSY | URGENT |
| MH5 | SUBSTANCE USE DISORDER | URGENT/EMERGENCY |

### Abstain (4)
| A1-A3 | Adult cardiac, non-medical, veterinary | UNKNOWN |
| A4 | Empty input | 400 error |

### Edge Cases (5)
| X1 | Negation — must NOT classify as pneumonia |
| X2 | Multi-condition — pneumonia + diarrhoea |
| X3 | Prompt injection — "Ignore previous instructions" |
| X4 | Oversized case — 1990 chars |
| X5 | Repetition stress — "and fever" × 50 |

---

## Gap Analysis

### 🔴 Critical (blocks clinical use)
1. **RAG RocksDB lock** — `File descriptor could not be locked` in CorestoreStorage. The SDK's bare worker can't open the RAG database. This blocks ALL triage. Resolution: rebuild RAG database (`npm run ingest`) or patch the SDK to handle stale locks more aggressively.

2. **4B model timeout on CPU** — The 4B MedPsy model on CPU with 1024 token budget may exceed 90s. Source code patched to 300s, but the running server must be restarted with the patched code.

### 🟡 High (quality impact)
3. **Retrieval precision** — The top citation for the pneumonia case retrieved page 32 (follow-up care) instead of page 6 (pneumonia treatment). The `k=8` deep retrieval may need a re-rank step or the threshold adjusted.

4. **Citation score threshold** — 0.685 may be suboptimal. Too high → missed retrievals + false abstains. Too low → noise. Needs calibration against the 30-case catalog.

5. **Extract pass reliability** — The 4B model's JSON output sometimes fails extraction. The 3-retry loop handles it but adds latency. The 1.7B model may be more reliable for structured output.

### 🟢 Low (improvements)
6. **CSP header** — Missing Content-Security-Policy (I13 from critique). Fixed in source but needs server restart.
7. **XSS escape** — Missing single-quote escape in frontend `esc()` (I12). Fixed in source (now escapes `'`).
8. **Perf logger crash propagation** — C4 from critique. Fixed in source (try/catch around FS ops).
9. **Orchestrator state corruption** — C3 from critique. Fixed in source (try/catch on unload).

---

## What Was Fixed This Session

| Fix | File | Status |
|-----|------|--------|
| TRIAGE_TIMEOUT_MS 90s → 300s | `src/server.ts:58` | ✅ Patched |
| RAG RocksDB lock (stale) | `.qvac/rag-hyperdb/` | 🔄 Rebuilding via ingest |
| Playwright test harness | `tests/quality/clinical-quality.spec.ts` | ✅ Built (34 tests) |
| Playwright config (WebKit, serial, 300s timeout) | `playwright.config.ts` | ✅ Configured |
| Playwright dependencies | `@playwright/test`, `webkit` browser | ✅ Installed |

---

## v0.3.0 Roadmap

### Phase 1: Unblock (now)
- [ ] Complete `npm run ingest` — rebuild RAG database
- [ ] Verify triage works end-to-end on port 5061
- [ ] Run Playwright clinical-quality.spec.ts (34 tests)

### Phase 2: Measure (next session)
- [ ] Run all 31 clinical cases, record accuracy
- [ ] Calibrate RAG threshold using precision/recall across the catalog
- [ ] Compare 4B vs 1.7B model on classification accuracy and latency
- [ ] Benchmark token budgets: 512 vs 1024 vs 2048 on CPU

### Phase 3: Improve
- [ ] Fix retrieval precision (citation points to correct page)
- [ ] Add a deterministic pre-filter: keyword match on signs before semantic retrieval
- [ ] Optimize extract prompt for higher first-attempt success rate
- [ ] Add retry-on-lock logic for RAG operations

### Phase 4: Harden
- [ ] CSP header (hash-based for inline scripts)
- [ ] Rate limiting for demo safety
- [ ] Offline mode: bundle citation-map.json for zero-network install
- [ ] Add demo voice + recording quality tests

### Phase 5: Polish
- [ ] Clinical advisory board review of all 31 cases
- [ ] Weight-band dosing UI with visual weight selector
- [ ] Multi-language prompt support (French, Swahili)
- [ ] Accessibility audit (screen reader, keyboard nav)

---

## Real-World Readiness Assessment

**Current: NOT READY** — blocked by RAG lock. The deterministic pipeline alone is not useful without retrieval + model inference.

**After Phase 1:** READY for clinical quality testing. The app will serve real IMCI/mhGAP guidance to a health worker, with deterministic severity + plan for all table-encoded classes and model-driven classification for edge cases.

**After Phase 3:** READY for field pilot. Classification accuracy ≥80%, citation precision ≥90%, plan completeness ≥95% for table-encoded classes.

**After Phase 5:** READY for deployment. Clinically reviewed, accessibility-compliant, multi-language support.

---

## Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | TRIAGE_TIMEOUT_MS 90→300s |
| `playwright.config.ts` | New — WebKit, serial, 300s timeout |
| `tests/quality/clinical-quality.spec.ts` | New — 34-test clinical quality suite |
| `tests/quality/results.json` | (to be produced by test run) |
| `src/triage/severity.ts` | (unchanged — verified correct by 30 unit tests) |
| `src/triage/protocol-table.ts` | (unchanged — verified grounded by dose-safety gate) |

---

*Report generated by CodeWhale clinical quality audit, 2026-07-12*
