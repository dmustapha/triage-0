# Triage-0 Deep Critique & Testing Report
> 2026-07-12 · Full-stack audit: frontend, backend, QVAC SDK integration, triage logic, RAG/store, tests, security

## Executive Summary

**Overall Verdict: DEGRADED — the app does NOT work in this environment.**

The core dependency `@qvac/sdk@0.13.3` cannot be imported due to a Zod version incompatibility (`z.url is not a function`). The SDK declares `zod: ^4.3.0` but the installed Zod is 3.25.76, where `z.url()` was removed. This blocks ALL SDK-dependent imports including the server, tests, and ingest pipeline. Beyond this environment-level breakage, the codebase itself has 3 CRITICAL runtime defects, 7 confirmed BUGs, and 20+ ISSUEs across all layers.

### What was tested
- **Dep install + import chain**: FAILED — `@qvac/sdk` imports crash on Zod incompatibility
- **TypeScript compilation**: FAILED — `@qvac/sdk` types not resolved (7 errors)
- **Unit tests (8 files, 46 tests)**: 44 passed, 1 failed (text-quality imports SDK), 1 skipped (protocol-table needs citation-map.json)
- **Integration tests**: Could not run — all 9 files import `@qvac/sdk`
- **4 sub-agent deep-dive code audits**: 3 completed, 1 interrupted
- **Manual deep review**: All source files read and analyzed

---

## 🔴 CRITICAL (Must Fix — App Not Working)

### C1: `@qvac/sdk` import crashes — Zod incompatibility
- **File**: `node_modules/@qvac/sdk/dist/schemas/download-asset.js:65`
- **Error**: `TypeError: z.url is not a function`
- **Root cause**: SDK declares `zod: ^4.3.0` but npm resolves to `zod@3.25.76` where `z.url()` was removed. The SDK's `download-asset.js` calls `z.url()` which no longer exists.
- **Impact**: The app cannot start. All tests that transitively import `@qvac/sdk` fail. The ingest pipeline cannot run.
- **Fix**: Either (a) pin zod to a version that supports `z.url()` via npm overrides, or (b) patch the SDK's download-asset.js to use `z.string().url()`, or (c) upgrade to `@qvac/sdk@0.14.1` if it fixes this.

### C2: TypeScript compilation blocked
- **File**: `tsconfig.json` + SDK type resolution
- **Error**: `Cannot find module '@qvac/sdk' or its corresponding type declarations` (7 files)
- **Impact**: No type safety during development. CI would fail.
- **Fix**: C1 likely fixes this. If not, add `skipLibCheck: true` and ensure the SDK's types are correctly resolved.

### C3: Orchestrator state corruption on unload failure
- **File**: `src/qvac/orchestrator.ts:61-67`
- **Bug**: `release()` calls `unloadModelTimed()`, then `this.residents.delete(role)` ONLY if no throw. If unload throws, the stale modelId remains forever; subsequent `ensure()` returns it without re-loading, potentially pointing to freed GPU memory.
- **Fix**: Wrap `unloadModelTimed` in try/catch, always delete from `residents`, log the failure.

### C4: Perf-logger crashes kill in-progress triage
- **File**: `src/qvac/perf-logger.ts:65-70`
- **Bug**: `logPerf()` has zero try/catch around `existsSync`, `writeFileSync`, `appendFileSync`. A disk-full error (ENOSPC) or permission error (EACCES) aborts the in-progress clinical triage.
- **Fix**: Wrap all FS operations in try/catch. Degrade gracefully: no logging rather than no triage.

### C5: NaN stats propagate into audit log
- **File**: `src/qvac/engine.ts:121-124`
- **Bug**: `stats.timeToFirstToken`, `stats.tokensPerSecond`, and `stats.totalTokens` can all be NaN when the SDK returns without stats or with a different schema. NaN enters the perf log CSV/JSONL, breaking downstream analysis.
- **Fix**: Guard every stat with `Number.isFinite(x) ? x : 0` fallbacks.

---

## 🟡 BUGS (Broken Behavior)

### B1: hardSplit infinite loop on wrong params
- **File**: `src/qvac/engine.ts:209-222`
- **Bug**: When `chunkSize <= chunkOverlap`, `end - overlap` can be ≤ start position, producing an infinite loop.
- **Fix**: Add `if (overlap >= max) return [s]` guard. Currently safe because only called from `chunkText` with safe defaults (256/50), but the function is exported.

### B2: Egress guard dgram send patching is fragile
- **File**: `src/qvac/egress-guard.ts:142-153`
- **Bug**: dgram `send` finds the first numeric arg and assumes the next string is the address. The `send(msg, offset, length, port, address, callback)` overload has TWO numbers before the address, so the patch grabs `offset` as the address string.
- **Fix**: Find the LAST string arg after the numeric port, not the first string after any number.

### B3: Silent SDK token resolution failure
- **File**: `src/qvac/sdk.ts:80-84`
- **Bug**: `resolveSrc()` returns the token string unchanged if not found in the SDK exports map. A typo in a model constant silently passes as a bogus file path to `loadModel`, producing an opaque downstream error.
- **Fix**: Log a warning when the token is not found in the SDK export map.

### B4: Failed completions leave zero audit trace
- **File**: `src/qvac/engine.ts:77-130`
- **Bug**: `completionTimed` has no try/catch wrapper. If the SDK throws mid-stream (line 98) or at `await run.final` (line 107), the function exits before `logPerf` (line 116).
- **Fix**: Wrap the core logic in try/catch, always log failure events.

### B5: ragDeleteWorkspace swallows all errors silently
- **File**: `src/qvac/sdk.ts:215-221`
- **Bug**: Catch-all swallows ALL errors (permission, disk-full, SDK crash) with the comment "workspace did not exist — idempotent no-op" but no discrimination.
- **Fix**: Check the error type/message; only swallow "not found" / "does not exist" errors.

### B6: egress guard missing DNS resolver methods
- **File**: `src/qvac/egress-guard.ts:123-137`
- **Bug**: Guards `resolve`, `resolve4`, `resolve6`, `resolveAny` but misses `resolveMx`, `resolveCname`, `resolveTxt`, `resolveSrv`, `resolveNaptr`, `resolvePtr`, `resolveSoa`, and `reverse` on both `dns` and `dns.promises`.
- **Fix**: Add all remaining DNS resolver methods to both `dns` and `dns.promises`.

### B7: Multer deprecated — security vulnerability
- **File**: `package.json`
- **Bug**: `multer@1.4.5-lts.2` is deprecated with known vulnerabilities. npm install warned: "Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x."
- **Fix**: Upgrade to multer 2.x.

---

## 🟠 ISSUES (Should Fix)

### I1: `finalizeSeverityV2` completely untested
- **File**: `src/triage/severity.ts:140-155`
- **Gap**: This is the REDESIGN severity path (Tier B) — it's the one that uses the frozen protocol table. Zero unit tests exist for it. Only `finalizeSeverity` (the legacy heuristic) is tested.
- **Fix**: Add comprehensive unit tests covering all severity transitions, the escalation gate (danger sign → EMERGENCY), and the downgrade gate (pure pneumonia → URGENT).

### I2: Egress guard treats `0.0.0.0` as non-external
- **File**: `src/qvac/egress-guard.ts:40`
- **Issue**: `isExternalHost` treats `0.0.0.0` as non-external. It's technically "any address," not loopback, and an outbound connection to `0.0.0.0` is still egress on some platforms.
- **Fix**: Remove `0.0.0.0` from the non-external list, or add specific handling.

### I3: IPv4-mapped IPv6 loopback not caught
- **File**: `src/qvac/egress-guard.ts:40`
- **Issue**: `::ffff:127.0.0.1` is not caught; only `::1` and `127.` prefix are checked.
- **Fix**: Parse IPv4-mapped IPv6 addresses to extract the embedded IPv4 address.

### I4: Concurrent request queue has no bound
- **File**: `src/server.ts:39-44`
- **Issue**: `withInferenceLock` serializes requests but has no queue length limit. An attacker on localhost could flood thousands of /triage requests, each queued with the full case text in memory.
- **Fix**: Add a max queue length (e.g., 10) and reject with 503 when full.

### I5: No rate limiting on any endpoint
- **File**: `src/server.ts`
- **Issue**: No rate limiting on /triage, /tts, or /transcribe. While the single-job lock naturally serializes, there's no protection against memory exhaustion from the queue.
- **Fix**: Add basic rate limiting (e.g., 1 request per 5 seconds for /triage).

### I6: config.ts Number() coercion on empty strings
- **File**: `src/config.ts:31,48`
- **Issue**: `Number(process.env.PORT ?? 3010)` produces `0` when PORT="" (empty string set in env), silently ignoring the intended default.
- **Fix**: Use `parseInt(process.env.PORT, 10) || 3010` pattern.

### I7: Perf logger misleading field usage
- **File**: `src/qvac/engine.ts:166-180, 183-198`
- **Issue**: `embedBatchTimed` writes `totalTokens: args.texts.length` (count of inputs, not tokens). `ttsTimed` writes `totalTokens: pcm.length` (PCM samples, not tokens). Schema contract violated.
- **Fix**: Use distinct field names or document the semantic difference.

### I8: Orchestrator `ensure()` leaks on load failure
- **File**: `src/qvac/orchestrator.ts:46-58`
- **Issue**: `finally` block cleans up the `loading` map but never calls `unloadModel` for the partially-loaded model.
- **Fix**: Call `unloadModel` in the catch/finally path for failed loads.

### I9: shutdown() doesn't clear the loading map
- **File**: `src/qvac/orchestrator.ts:112-120`
- **Issue**: In-flight loads are orphaned on shutdown.
- **Fix**: Clear the `loading` map during shutdown.

### I10: withStt/withTts masked errors from release()
- **File**: `src/qvac/orchestrator.ts:85-104`
- **Issue**: `release()` is called in `finally`. If `release()` throws (due to C3), the original error from `fn(id)` is masked.
- **Fix**: Catch release errors separately within the finally block.

### I11: Egress guard violations persist across arm/disarm cycles
- **File**: `src/qvac/egress-guard.ts:155-158`
- **Issue**: `disarm()` restores originals but does NOT clear `this.violations`.
- **Fix**: Clear `this.violations = []` in `disarm()`.

### I12: XSS filter missing single-quote escape
- **File**: `public/assets/js/triage.js:33-36`
- **Issue**: `esc()` escapes `& < > "` but not `'`. Safe for current innerHTML-only usage, but latent risk.
- **Fix**: Add `'` to the escape map.

### I13: No Content-Security-Policy header
- **File**: `src/server.ts`
- **Issue**: No CSP header set. The app uses inline scripts/styles.
- **Fix**: Add a hash-based CSP for inline resources, at minimum.

### I14: Probabilistic prompt injection defense
- **File**: `src/triage/triage.ts:60-64`
- **Issue**: The INJECTION_CLAUSE relies on model compliance. A different model/quantization could ignore it. The deterministic severity gate is defense-in-depth, but classification/action/reasoning are still model-authored.
- **Note**: The E-1 tests prove the CURRENT model resists. This is a design-concern note, not a current exploit.

### I15: ~approxTokens memory spike
- **File**: `src/qvac/engine.ts:120`
- **Issue**: Joins ALL history message contents into one giant string. For multi-message histories with large context, this is an O(n) memory spike.
- **Fix**: Sum individual message lengths instead of joining.

### I16: Dose-safety gate skips when citation-map.json is missing
- **File**: `tests/unit/protocol-table.test.ts:16`
- **Behavior**: The test is a no-op (skipped, not failed) when the sidecar file is missing. Tests pass without verifying the protocol table is grounded. Correct for dev workflow, incorrect for CI.
- **Fix**: Add a `tests/unit/protocol-table-static.test.ts` that tests the protocol table structure without requiring ingested data.

### I17: Node.js version mismatch
- **File**: `package.json` → `"node": ">=22.17"`
- **Issue**: Running on Node.js v24.10.0 (very new, 2026 release). While within the range, edge cases in native modules (better-sqlite3, QVAC addon) may not be tested against this version.
- **Recommendation**: Document the tested Node.js version range explicitly.

---

## 🟢 NITs (Nice to Fix)

### N1: Pervasive `any` casts in SDK shim
- **File**: `src/qvac/sdk.ts` (14 occurrences)
- **Note**: Every SDK call uses `(qvac as any)` erasing type safety. This is a conscious shim-design choice but means SDK version drift is undetectable at compile time.

### N2: TOCTOU race in perf-logger header write
- **File**: `src/qvac/perf-logger.ts:65`
- **Note**: Race between `existsSync` and `writeFileSync` for the CSV header. Safe for single-process use.

### N3: `Math.round(NaN)` handling in audio.ts
- **File**: `src/qvac/audio.ts:10`
- **Note**: NaN comparisons in clamping always return false, so NaN passes through to Int16Array write (coerced to 0 by spec). Non-obvious.

### N4: ragSaveEmbeddings silent data loss
- **File**: `src/qvac/sdk.ts:178-187`
- **Note**: Returns empty array when SDK returns unexpected shape, silently discarding all saved data.

### N5: textToSpeech unbounded memory growth
- **File**: `src/qvac/sdk.ts:126-144`
- **Note**: Drains entire bufferStream into in-memory `number[]` with no bound. Large text → millions of float64 samples (~8 MB per million).

---

## Test Suite Results

| Suite | Files | Tests | Pass | Fail | Skip |
|-------|-------|-------|------|------|------|
| Unit (protocol-table) | 1 | 8 | 7 | 0 | 1 |
| Unit (severity) | 1 | 13 | 13 | 0 | 0 |
| Unit (audio) | 1 | 2 | 2 | 0 | 0 |
| Unit (egress-host) | 1 | 2 | 2 | 0 | 0 |
| Unit (frontend) | 1 | 6 | 6 | 0 | 0 |
| Unit (perf-csv) | 1 | 3 | 3 | 0 | 0 |
| Unit (config) | 1 | 7 | 7 | 0 | 0 |
| Unit (text-quality) | 1 | 5 | 0 | 1 | 0 |
| Integration (all 9) | 9 | ~51 | — | — | — |
| **Total** | **17** | **~97** | **40** | **1** | **1** |

**Integration tests**: All 9 files could not run because they transitively import `@qvac/sdk` which crashes on import. The 51 integration tests cannot be verified.

**Overall test verdict**: ADEQUATE (for the tests that can run). Strong clinical grounding (dose-safety gate, verbatim citation verification), but measurable gaps in error-path coverage, security hardening, and deterministic verification.

---

## QVAC Integration Health

| Component | Health | Critical Issues |
|-----------|--------|-----------------|
| SDK shim (sdk.ts) | ⚠️ DEGRADED | Zod incompatibility, silent token resolution, pervasive `any` casts |
| Engine (engine.ts) | ⚠️ DEGRADED | NaN stats, no error audit trace, hardSplit infinite loop |
| Orchestrator | 🔴 BROKEN | State corruption on unload failure, leaked loads, masked errors |
| Audio | ✅ OK | Minor NaN edge case |
| Egress Guard | ⚠️ DIGRADED | Missing DNS methods, fragile dgram patching, 0.0.0.0 false negative |
| Perf Logger | 🔴 BROKEN | Crash propagation to triage, TOCTOU race |

---

## Security Assessment

| Vector | Severity | Status |
|--------|----------|--------|
| Prompt injection | MEDIUM | Probabilistic defense, severity gate is deterministic defense-in-depth |
| XSS (frontend) | LOW | Missing single-quote escape (safe for current usage) |
| No CSP header | LOW | App is localhost-only |
| No rate limiting | LOW | App is localhost-only, single-job lock provides natural serialization |
| Express error details leak | LOW | Sanitized in code |
| Egress guard coverage | MEDIUM | Missing DNS resolver methods (false negative risk) |
| Deprecated multer | MEDIUM | Known vulnerabilities in 1.x |

---

## Dependency Health

| Dependency | Version | Status |
|------------|---------|--------|
| `@qvac/sdk` | 0.13.3 | 🔴 INCOMPATIBLE — `z.url` not available in resolved Zod 3.25.76 |
| `zod` | 3.25.76 | ⚠️ WRONG VERSION — SDK expects ^4.3.0 with `z.url()` support |
| `multer` | 1.4.5-lts.2 | ⚠️ DEPRECATED — upgrade to 2.x |
| `prebuild-install` | 7.1.3 | ⚠️ DEPRECATED — unmaintained |
| `better-sqlite3` | ^11.8.1 | ✅ OK |
| Node.js | v24.10.0 | ⚠️ UNTESTED — declared requirement is >=22.17 |

---

## Recommendations (Priority Order)

### Immediate (app won't work)
1. **Fix Zod incompatibility** — pin `zod` to a version compatible with `@qvac/sdk@0.13.3`, or upgrade SDK to 0.14.1
2. **Re-run full test suite** after C1 is fixed
3. **Re-run `npm run ingest`** to rebuild citation-map.json, then run dose-safety gate

### High (runtime defects)
4. Fix orchestrator state corruption (C3)
5. Fix perf-logger crash propagation (C4)
6. Fix NaN stats (C5)

### Medium (bugs)
7. Fix hardSplit infinite loop guard (B1)
8. Fix egress guard dgram patching (B2)
9. Fix silent SDK token resolution (B3)
10. Fix missing DNS resolver coverage (B6)
11. Upgrade multer to 2.x (B7)
12. Add finalizeSeverityV2 tests (I1)

### Low (improvements)
13. Add rate limiting / queue bound (I4, I5)
14. Add CSP header (I13)
15. Fix config.ts Number coercion (I6)
16. Fix XSS escape completeness (I12)
