# Triage-0 V2 — Full Product Upgrade Plan
> **Last updated:** 2026-07-12 19:40 — Zod fixed, testing gate added  
> **Critique report:** `DEEP-CRITIQUE-REPORT.md`  
> **Handoff:** `HANDOFF.md`

**Project:** `/Users/MAC/triage-0`  
**Remote:** `https://github.com/dmustapha/triage-0`  
**Goal:** Portfolio-ready v0.2.0 — all critical defects fixed, every feature end-to-end tested  
**Deps policy:** `@qvac/sdk` 0.13.3 → 0.14.1, zod v4 for SDK compat  
**Process:** Plan → approve → build → test → critique → fix → ship

---

## 0. Current state

| Area | Status |
|------|--------|
| Zod/SDK import | ✅ FIXING — installed `zod@4.0.17`, postinstall patch for `download-asset.js` |
| npm install | ✅ Clean — removed dead `better-sqlite3` |
| Typecheck | Will verify after SDK import chain works |
| Unit tests | 44/46 pass (baseline); will re-run once SDK imports |
| Integration tests | All 9 suites blocked by SDK — will unlock post-fix |
| QVAC SDK | 0.13.3, target 0.14.1 |
| **Deep critique** | 5 CRITICAL, 7 BUGs, 16+ ISSUEs |

**The Zod saga (resolved):**
- `@qvac/sdk` was built for Zod v4 API (`z.url()`, `schema.extend()`, etc.)
- npm incorrectly resolved Zod v3 which lacks these APIs
- **Fix:** Install `zod@4.0.17` (version the SDK tolerates) + postinstall script patches one remaining `z.url()` → `z.string().url()` call
- `better-sqlite3` removed — blocked native compilation on Node 24

---

## Phases

### Phase 0.5 — Foundation (IN PROGRESS)

| Step | Status | What |
|------|--------|------|
| 0.5a | 🔄 IN PROGRESS | Zod compat: `zod@4.0.17` + postinstall patch |
| 0.5b | ⬜ PENDING | Orchestrator: wrap `unloadModelTimed` in try/catch |
| 0.5c | ⬜ PENDING | Perf-logger: FS error → graceful degradation |
| 0.5d | ⬜ PENDING | Engine: guard NaN stats |
| 0.5e | ⬜ PENDING | Engine: hardSplit infinite loop guard |

### Phase A — SDK upgrade
- `@qvac/sdk` 0.13.3 → 0.14.1
- SDK reconcile: diff exports, verify all functions
- Update RECONCILE.md
- **Exit:** green typecheck + unit tests

### Phase B — Clinical hardening
- Test `finalizeSeverityV2` (currently 0 coverage)
- Audit remaining weak paths
- Max 3 targeted clinical expansions

### Phase C — Frontend + security
- XSS: add `'` to `esc()`
- CSP header on Express
- Landing + app polish

### Phase D — Docs + repo
- Bump to 0.2.0
- `FOR[Dami].md`
- README refresh

### Phase E — Verification
- All gates: typecheck, unit, integration, dose-safety, egress, smoke, manual seeds

### Phase F — End-to-End Testing & Critique Gate (NEW)

**Purpose:** Before declaring v0.2.0 done, every feature is tested end-to-end using real browser automation and real server interactions. Every bug found is fixed. Every edge case is exercised.

**Tools available:** Playwright, Chrome DevTools, dev server (localhost:3010), npm test, bash

#### F1. Start dev server
```bash
cd /Users/MAC/triage-0 && PORT=3010 npm start &
# Wait for "Triage-0 listening on http://localhost:3010"
# Wait for "[triage-0] models pre-warmed; first triage will be fast"
```

#### F2. Health check
```bash
curl -s http://localhost:3010/health | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.ok ? '✅ Health OK' : '❌ Health FAILED'); console.log('Chunks:', d.chunks, '| Models:', d.residentModels)"
```

#### F3. Frontend journey (Playwright)
```
1. Landing page (http://localhost:3010)
   - Loads without console errors
   - GitHub link resolves correctly
   - Offline badge shows
   - Mobile viewport (390px) holds layout

2. App tool (http://localhost:3010/app)
   - Loads without console errors
   - Seeds render (3 example chips)
   - Text input works
   - "Get guidance" button triggers SSE
   - Ctrl+Enter triggers assess
   - Offline badge reflects navigator.onLine

3. Triage flow (text input)
   - Enter "2-year-old, cough for 3 days, chest indrawing, breathing 52 a minute"
   - Citation event arrives first (< 3s)
   - Reasoning streams follow
   - Card renders with severity badge
   - Plan renders with medicines/dose table
   - Perf numbers populate (ttft, tps, device)
   - "Speak" button reads action aloud (TTS)

4. Abstain flow
   - Enter "What is the capital of France?"
   - Abstain card renders (UNKNOWN severity)
   - No model called (citation was abstain)

5. Voice flow (STT)
   - Upload test audio → transcription returned
   - Transcribed text fills case box

6. Error paths
   - Empty case → inline message, not crash
   - Case > 2000 chars → 400 error
   - Server down → graceful error message
```

#### F4. API endpoint testing (curl)
```
POST /triage      — happy path, abstain, oversized, empty, malformed JSON
POST /transcribe  — valid audio, no file, oversized
POST /tts         — valid text, empty text, oversized (>1000 chars)
GET  /health      — baseline health
GET  /perf-log    — JSON array
GET  /perf-log.csv — CSV file
```

#### F5. Run full test suite
```bash
npm run typecheck
npm test  # all unit + integration (--test-concurrency=1)
```

#### F6. Performance verification
- perf-log.csv has rows for every inference
- No NaN values in numeric columns
- All events logged: load, transcribe, embed, completion, tts, unload

#### F7. Egress guard verification
```bash
node --import tsx scripts/egress-check.ts
```
- Arm guard → run triage → disarm → violations must be empty

#### F8. Critique & fix loop
For every bug found in F1-F7:
1. Document in `CRITIQUE-LOG.md`
2. Fix in source
3. Re-run affected tests
4. Verify fix

#### F9. Final gate
- All Playwright tests pass
- All curl tests pass  
- `npm test` all green
- `npm run typecheck` clean
- Egress guard clean
- No NaN in perf log
- 5 seed cases produce expected clinical output

**Exit:** Green across all gates. `CRITIQUE-LOG.md` documents everything found and fixed.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Zod v4 API drift in SDK | Using v4.0.17 (earliest stable v4); SDK declares `^4.3.0` but tested against earlier |
| Node 24 compatibility | All native deps compile; only known issue was better-sqlite3 (removed) |
| Models not cached | Phase F requires pre-warmed models; skip STT/TTS if models missing |
| Integration tests need models | Run unit always; integration when models warm |

---

## Handoff for next session

See `HANDOFF.md` in the repo root — a complete context packet for continuing this work in a fresh chat.
