# Manual frontend checklist — `public/assets/js/triage.js`

## Why this is a manual checklist, not an automated jsdom test

`triage.js` is a single self-invoking IIFE (`(function () { … })();`). Every function that the test
plan wants to exercise — `handleEvent(block)`, `esc(s)`, `renderCard(card)`, `renderPlan(plan)`,
`runAssess()` — and the `gotTerminal` guard are **closure-private**: nothing is assigned to `window`,
`module.exports`, or any global. The IIFE also runs its side-effects the instant it is evaluated
(builds the seed chips, wires `onclick`/`keydown` handlers, and fires `fetch("/health")`).

Consequently a jsdom test cannot:
- call `handleEvent` / `esc` directly (they are unreachable), nor
- evaluate the script without triggering a live `fetch("/health")` and DOM wiring that expects the full
  `#id` set to exist.

Driving the IIFE indirectly (synthesising a real `fetch` SSE `ReadableStream` and clicking `#assess`)
would test the network plumbing, not the four pure behaviours below, and would couple the test to a
mocked `fetch` + `ReadableStream` + `MediaRecorder` surface — brittle and low-signal. **The task forbids
editing `triage.js`**, so the four behaviours are documented here for a manual pass instead.

## Minimal export hook that would make this automatable (NOT applied)

Add ONE line at the very end of the IIFE, just before the closing `})();`:

```js
// Test seam (no behavioural change): expose the pure helpers when running under a test harness.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { handleEvent: handleEvent, esc: esc, renderCard: renderCard, renderPlan: renderPlan };
}
```

That is insufficient on its own, because the IIFE's top-level side effects (`fetch("/health")`, the
seed-chip build, the handler wiring) run on import. A clean seam needs the script guarded so the
side-effecting bootstrap only runs in a browser:

```js
function boot() { /* seed chips, /health fetch, $("rec")/$("assess") wiring … */ }
if (typeof document !== "undefined" && typeof module === "undefined") boot();
```

With both hooks, a jsdom test could `require("../public/assets/js/triage.js")`, build a jsdom
`document` carrying the `#citationBox #card #reasoning #reasoningWrap #planWrap #err #reasonLabel
#hTtft #hTps #hDev` ids, and assert the four behaviours below by calling the exported functions.
`gotTerminal` would additionally need to be exposed via a getter (e.g. `getGotTerminal()`), since the
"did not finish" branch lives in `runAssess`, which also owns the `fetch` call.

## Manual verification checklist (run in a browser at `/app`)

1. **Malformed SSE frame is skipped, never crashes the stream.**
   `handleEvent` JSON-parses `data:` inside a `try/catch` and `return`s on a parse error
   (`triage.js` line ~203). To verify: in DevTools, throttle and observe that a partially-delivered
   `data:` chunk does not throw in the console; the stream continues and a later `card` still renders.
   PASS = no uncaught exception, the eventual card appears.

2. **A stream that ends with no card/abstain/error shows the "did not finish" message.**
   `runAssess` sets `gotTerminal = false` at start; `card`/`abstain`/`error` set it `true`. After the
   reader drains, `if (!gotTerminal)` writes `"The guidance did not finish. Try again."` to `#err` and
   hides `#reasoningWrap` (line ~280). To verify: point at a `/triage` that emits only `citation` +
   `reasoning` then closes (e.g. kill the server mid-reason). PASS = the `#err` message appears, no blank
   card is left behind, and the `#assess` button is re-enabled (the `finally` block).

3. **`esc` entity-escapes an injection payload.**
   `esc` replaces `& < > "` (line ~33). To verify: paste a case whose echoed text contains
   `<img src=x onerror=alert(1)>`. PASS = it renders as literal text in the card/citation/plan,
   the `onerror` never fires, and `view-source` shows `&lt;img … &gt;` not a live `<img>` tag.

4. **Out-of-order `plan` before `card` does not throw.**
   `renderPlan` reads `$("planWrap")` and returns early if it is absent (line ~165–166). The `#planWrap`
   element is created by `renderCard`, so a `plan` event arriving before `card` finds no `#planWrap` and
   returns harmlessly. To verify: replay an SSE log with the `plan` frame moved before the `card` frame.
   PASS = no console error; once the `card` arrives and creates `#planWrap`, a subsequent `plan` (or a
   re-render) populates it.

## Status

- [ ] 1. Malformed SSE frame skipped
- [ ] 2. "Did not finish" message on premature stream end
- [ ] 3. `esc` neutralises `<img onerror>`
- [ ] 4. plan-before-card does not throw
