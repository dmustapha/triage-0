# Triage-0 Clinical Quality Audit — Session Handoff
> 2026-07-13 · For next session: resume clinical quality audit

## Current State

**Phase 1 (Fix model inference): ✅ COMPLETE**
- Clean 4B MedPsy model downloaded — 2,716,068,640 bytes (exact match, no corruption)
- temp=0.3 + repeat_penalty=1.1 committed at HEAD (5e36397)
- Model produces coherent clinical reasoning: ~69s reason pass + ~42s extract pass
- R1 pneumonia case verified end-to-end: PNEUMONIA, URGENT, amoxicillin with weight-band dosing, full WHO plan, correct citation (page 6, score 0.737)
- 88/88 unit tests pass

**Phases 2-9: READY TO RUN — blocked was resolved**
- Zombie qvac-worker processes were holding RAG RocksDB locks → you ran `pkill -f qvac`
- Default RAG workspace deleted → `rm -rf ~/.qvac/rag-hyperdb/triage0-who-protocols`
- **`triage0-who-audit` workspace exists with 997 chunks** — use this!

## What To Do Next Session

### 1. Kill remaining servers (they have no RAG data)
```bash
lsof -ti:5066,5067,5068 | xargs kill
```

### 2. Start server with audit workspace
```bash
cd /Users/MAC/triage-0
TRIAGE0_RAG_WORKSPACE=triage0-who-audit MODEL_ID=4b REASON_PREDICT=1024 PORT=5070 npm start
```
Wait for health: `curl -s http://localhost:5070/health` → both models in residentModels

### 3. Update audit script port
Edit `scripts/clinical-audit.ts` line 7: change `const BASE = "http://localhost:5068";` to `"http://localhost:5070"`

### 4. Run the clinical audit
```bash
node --import tsx scripts/clinical-audit.ts
```
29 cases, ~110s each → ~53 minutes total. Outputs to `tests/quality/results.json`.

### 5. Analyze results & update CLINICAL-QUALITY-REPORT.md

## What's Built

| File | Purpose |
|------|---------|
| `scripts/clinical-audit.ts` | Direct API test runner — 29 cases, SSE parsing, classification/severity/plan validation |
| `scripts/quick-test.sh` | Single triage test via curl |
| `tests/quality/clinical-quality.spec.ts` | Playwright spec (34 tests) — but WebKit headless crashes, so use audit.ts instead |
| `playwright.config.ts` | Playwright config (WebKit, serial) |

## What Was Learned

1. **4B model file was corrupted** — original download had 8MB size mismatch. Fresh download at exact size fixed the garbage output.
2. **RAG RocksDB lock** — the SDK's bare worker processes hold file descriptor locks. When a server is killed, the bare worker survives and blocks all subsequent servers. Solution: `pkill -f qvac` + `npm run ingest`.
3. **Separate RAG workspace** — using `TRIAGE0_RAG_WORKSPACE` env var avoids lock conflicts with zombie workers from old servers.
4. **Playwright WebKit won't launch** — headless WebKit crashes with "browser.newPage: Test ended". Use the direct API audit script instead.

## Key Git State
- Branch: main
- HEAD: 5e36397 (temp=0→0.3 + repeat_penalty)
- All files committed, working tree clean
