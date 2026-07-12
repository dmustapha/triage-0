# FOR[Dami].md — Triage-0 Developer Education
> Learnings from building v0.2.0 of an offline clinical decision-support tool.

---

## Part A: Vocabulary

| Term | What It Actually Means | Example |
|------|----------------------|---------|
| **SSE** (Server-Sent Events) | Server pushes events to browser over one long HTTP connection. Unlike WebSockets, it's one-way (server→client) and works with plain HTTP. | The `/triage` endpoint streams `citation`, `reasoning`, `card`, `done` events to the browser. |
| **Embedding** | Turning text into a list of numbers (a vector) so computers can compare meaning. | "chest indrawing" → [0.12, -0.34, 0.87, ...] |
| **RAG** (Retrieval-Augmented Generation) | Search relevant documents first, then feed them to the model so it answers from real sources instead of hallucinating. | The model answers "pneumonia → amoxicillin" because it was shown the IMCI page, not because it guessed. |
| **Zod** | A TypeScript library for validating data shapes at runtime. Like TypeScript types but they actually run. | `z.string().url()` checks a string is a valid URL when the code executes. |
| **try/catch** | Wrapping risky code so if it breaks, the program keeps running instead of crashing. | `try { writeFile(...) } catch { /* disk full? no problem */ }` |
| **NaN** | "Not a Number" — what JavaScript gives you when math goes wrong (e.g., `0/0`). Must be guarded or it corrupts logs. | `Math.round(NaN)` → NaN. Use `Number.isFinite(x) ? x : 0`. |
| **CSP** (Content-Security-Policy) | An HTTP header that tells the browser what sources of scripts/styles/images are allowed. Defence against XSS. | `script-src 'self'` means only scripts from your own domain. |
| **XSS** (Cross-Site Scripting) | When attacker injects `<script>` tags into your page. Prevented by escaping HTML characters. | `esc("<script>")` → `"&lt;script&gt;"` |
| **TOCTOU** (Time-of-Check to Time-of-Use) | A race condition: checking something is fine, then using it after it changed. | Checking `existsSync(file)` then writing — file could be deleted between. |
| **Singleton** | A class/object that exists exactly ONCE in the whole program. | `orchestrator` — one model lifecycle manager per process. |
| **Idempotent** | Doing something twice has the same effect as doing it once. | Escalating to EMERGENCY when already EMERGENCY — result is still EMERGENCY. |
| **Enum** | A fixed set of allowed values. | `Severity` can only be `"EMERGENCY" | "URGENT" | "ROUTINE" | "SELF_CARE" | "UNKNOWN"`. |
| **SSR vs CSR** | Server-Side Rendering (HTML built on server) vs Client-Side Rendering (JS builds HTML in browser). Triage-0 is CSR with Express serving static files. |
| **Middleware** | A function Express runs on every request before the route handler. | CSP header middleware, JSON body parser. |
| **Postinstall script** | A script that runs automatically after `npm install`. Used here to patch the SDK. | `scripts/patch-sdk-zod.mjs` runs after every `npm install`. |

---

## Part B: How to Prompt Claude Better

### Bad vs Good Prompts

| ❌ Bad | ✅ Good |
|--------|--------|
| "Fix the bug" | "In `src/qvac/orchestrator.ts:61-67`, `release()` doesn't delete from `residents` map when unload throws. Wrap in try/catch." |
| "Add tests" | "Add unit tests for `finalizeSeverityV2` covering: table path, fallback path, escalation, downgrade, negation." |
| "Make it better" | "Guard all numeric stats with `Number.isFinite(x) ? x : 0` in `engine.ts:121-124` to prevent NaN in the perf log." |

### The Prompt Formula

```
[CONTEXT] + [TASK] + [CONSTRAINTS] + [EXPECTED OUTPUT]
```

Example:
- **Context:** "In `src/qvac/perf-logger.ts`, `logPerf()` has no error handling."
- **Task:** "Wrap all `existsSync`/`writeFileSync`/`appendFileSync` calls in try/catch."
- **Constraints:** "Don't change the function signature. Don't log — just degrade silently."
- **Expected output:** "A disk-full error must not crash an in-progress clinical triage."

---

## Part C: Frontend Development

### Pattern: Vanilla JS Component
```javascript
// 1. Grab DOM elements
var $ = function (id) { return document.getElementById(id); };

// 2. Escape ALL user-facing strings
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// 3. Render HTML strings (innerHTML is fine when you escape)
function renderCard(card) {
  return '<div class="card">' +
    '<span class="badge">' + esc(card.severity) + '</span>' +
    '<p>' + esc(card.classification) + '</p>' +
  '</div>';
}
```

---

## Part D: Backend Development

### Pattern: Express Route with Error Handling
```typescript
// 1. Validate input first
if (!caseText) return res.status(400).json({ error: "caseText is required." });

// 2. Set up SSE
res.setHeader("Content-Type", "text/event-stream");

// 3. Track connection state
let closed = false;
res.on("close", () => { closed = true; });

// 4. Safe send that handles disconnects
const send = (event: string, data: unknown) => {
  if (closed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// 5. Always end the stream in finally
try { /* work */ } finally { endStream(); }
```

---

## Part E: Testing Patterns

### Node.js Built-in Test Runner
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";

test("PNEUMONIA with chest indrawing → URGENT", () => {
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral Amoxicillin", "chest indrawing, no danger signs", []),
    "URGENT",
  );
});
```

### Test Names Should Tell the Story
- ✅ `"danger sign ESCALATES any band to EMERGENCY"`
- ✅ `"negated danger signs do NOT escalate"`
- ❌ `"test severity"`
- ❌ `"edge case 3"`

---

## Part F: Debugging & Problem Solving

### The Debugging Loop
1. **Reproduce** — can you trigger it consistently?
2. **Isolate** — what's the smallest input that breaks?
3. **Trace** — follow the data: what goes in, what comes out?
4. **Hypothesize** — what could cause THIS output?
5. **Verify** — does your fix change the output correctly?
6. **Check side effects** — did you break anything else?

### Common Errors

| Error | What It Means | Fix |
|-------|-------------|-----|
| `z.url is not a function` | Zod version mismatch — SDK expects v4 but v3 is installed | Pin zod@4.0.17, or patch the import |
| `Cannot find module '@qvac/sdk'` | SDK types not resolved | Check node_modules, run npm install |
| `TypeError: Cannot read properties of undefined` | You're accessing `.foo` on something that's `undefined` | Add optional chaining: `obj?.foo` |
| `ENOSPC` | Disk is full | Wrap FS ops in try/catch, degrade gracefully |
| `EACCES` | Permission denied on a file | Check file permissions, wrap in try/catch |

---

## Part G: Mistakes Made

### 1. `z.url()` crash on import
- **What I did:** Used `@qvac/sdk@0.13.3` without pinning zod version
- **What happened:** npm resolved zod@3.25.76 which removed `z.url()`
- **Fix:** Pinned `zod@4.0.17` + postinstall patch for remaining `z.url()` call

### 2. Test assertion for PNEUMONIA_SIGN_RE regex
- **What I did:** Tested "no chest indrawing" expecting NO match
- **What happened:** PNEUMONIA_SIGN_RE is substring-based — it found "chest indrawing" inside "no chest indrawing"
- **Lesson:** Always check if regex matches are substring-aware. Negation checking needs explicit logic.

### 3. "seizure" is in DANGER_RE
- **What I did:** Used "seizure episodes" as a passthrough epilepsy test case
- **What happened:** `hasEmergencySign` found "seizure" and escalated to EMERGENCY
- **Lesson:** Always check what terms are in your regex lists before writing tests.

### 4. PSYCHOSIS escalation phrasing
- **What I did:** Used "wants to end it all" expecting DANGER_RE match
- **What happened:** DANGER_RE has `wants? to die` but NOT "end it all"
- **Lesson:** Test your regex patterns against the EXACT strings you use in tests.

---

## Part H: What to Learn Next

**This week:** TypeScript generics, Express middleware patterns, regex lookbehinds
**This month:** WebSocket vs SSE tradeoffs, CSP hash-based policies, CI/CD pipelines
**This quarter:** Docker containerization, database design (SQLite/RocksDB), authentication patterns

---

## Part I: Quizzes

### Quiz: Error Handling
1. What happens if `writeFileSync` throws and you DON'T wrap it in try/catch?
2. Why use `Number.isFinite(x)` instead of `!isNaN(x)`?
3. What's the difference between `try/catch` and `.catch()` on a Promise?

<details>
<summary>Answers</summary>
1. The error propagates up and crashes the program (or the current request handler).
2. `isNaN("hello")` is true, `Number.isFinite("hello")` is false. `Number.isFinite` also catches Infinity.
3. `try/catch` catches synchronous throws; `.catch()` catches Promise rejections. `async/await` lets you use try/catch for both.
</details>

### Quiz: Severity Logic
1. Why does `finalizeSeverityV2` escalate BEFORE checking downgrade?
2. What happens when a case has BOTH a pneumonia sign AND a danger sign?
3. Why is `hasEmergencySign` negation-aware per CLAUSE, not per fixed character window?

<details>
<summary>Answers</summary>
1. Escalation (danger sign → EMERGENCY) is clinically more important than downgrade (pneumonia-only → URGENT). A danger sign ALWAYS means emergency.
2. Escalation wins — returns EMERGENCY. The downgrade check never fires because the function returns early.
3. A fixed character window was too short for "no thoughts of self-harm" (missed the negation) and too greedy for "no fever but unconscious" (wrongly negated a real danger sign). Clause-scoping fixes both.
</details>

---

## Glossary

| Slang | Meaning |
|-------|---------|
| **Bike-shedding** | Arguing about trivial details instead of important decisions |
| **Yak shaving** | Doing a seemingly unrelated task that's actually needed for the main task |
| **Rubber ducking** | Explaining your problem out loud to understand it better |
| **Bikeshed** | Same as bike-shedding |
| **DX** | Developer Experience — how nice it is to work with the code |
| **UX** | User Experience — how nice it is to use the product |
| **MVP** | Minimum Viable Product — the smallest thing that works |
| **PR** | Pull Request — proposing code changes to merge |
| **LGTM** | Looks Good To Me — approval on a code review |
| **TDD** | Test-Driven Development — write tests first, then code |
| **DRY** | Don't Repeat Yourself — extract shared code |
