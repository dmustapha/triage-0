// File: tests/unit/frontend.test.ts
// jsdom unit tests for the front-end render/parse logic in public/assets/js/triage.js.
// triage.js is a browser IIFE; it exposes its pure functions via a browser-safe `module.exports`
// hook (a no-op in the browser). We stand up a jsdom DOM with the app's element IDs, stub fetch +
// matchMedia, then require the script (which runs its harmless auto-wiring) and exercise the renderers.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - jsdom ships no bundled types; tests/ is outside the build-gate tsconfig anyway.
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

// Element IDs the app wiring + renderers touch (planWrap is created INSIDE #card by renderCard).
const IDS = [
  "seeds", "rec", "status", "citationBox", "reasoning", "reasoningWrap", "reasonLabel", "reasonTimer",
  "card", "err", "result", "hTtft", "hTps", "hDev", "hChunks", "net", "assess",
];
// `#case` is a <textarea> (runAssess reads `.value`); the rest are plain divs.
const body = `<textarea id="case"></textarea>` + IDS.map((id) => `<div id="${id}"></div>`).join("");
const dom = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { url: "http://localhost:3010/app" });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// (navigator is getter-only on the Node global and is only read in the click handler, never at import)
(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
// jsdom does not implement scrollIntoView; runAssess calls it. No-op it so the flow does not throw.
(dom.window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype.scrollIntoView = function () {};
g.fetch = async () => ({ json: async () => ({ chunks: 994, residentMode: "resident", medpsy: "1.7b" }), headers: { get: () => null } });

const require = createRequire(import.meta.url);
const fe = require("../../public/assets/js/triage.js") as {
  esc: (s: string) => string;
  doseTable: (b: { band: string; dose: string }[]) => string;
  renderCard: (card: Record<string, unknown>, classification: string) => void;
  renderPlan: (plan: Record<string, unknown>) => void;
  handleEvent: (block: string) => void;
  runAssess: () => Promise<void>;
  startReasonTimer: () => void;
  stopReasonTimer: () => void;
};
const card = () => dom.window.document.getElementById("card")!.innerHTML;

test("esc escapes HTML metacharacters", () => {
  assert.equal(fe.esc('<a>&"x'), "&lt;a&gt;&amp;&quot;x");
});

test("doseTable renders weight-band rows and escapes the band label", () => {
  const html = fe.doseTable([{ band: "5 - <10 kg", dose: "1 tablet" }]);
  assert.match(html, /5 - &lt;10 kg/);
  assert.match(html, /1 tablet/);
  assert.equal(fe.doseTable([]), "", "empty bands → empty string (no table)");
});

test("renderCard is diagnosis-first: severity, classification, why, action, plan slot", () => {
  fe.renderCard({ severity: "EMERGENCY", action: "Refer URGENTLY to hospital", reasoning: "a general danger sign", red_flags: [] }, "SEVERE PNEUMONIA OR VERY SEVERE DISEASE");
  const h = card();
  assert.match(h, /sev EMERGENCY/);
  assert.match(h, /Classification/);
  assert.match(h, /SEVERE PNEUMONIA OR VERY SEVERE DISEASE/);
  assert.match(h, /a general danger sign/);
  assert.match(h, /Refer URGENTLY to hospital/);
  assert.match(h, /id="planWrap"/, "non-UNKNOWN card shows a pending plan slot");
});

test("renderCard on UNKNOWN hides the classification and the plan slot", () => {
  fe.renderCard({ severity: "UNKNOWN", action: "Escalate to a clinician", red_flags: [] }, "");
  const h = card();
  assert.ok(!/Classification/.test(h), "no classification label on abstain");
  assert.ok(!/id="planWrap"/.test(h), "no plan slot on abstain");
});

test("renderPlan lays out medicines (dose table), supportive, return-now, follow-up detail", () => {
  // renderCard (non-UNKNOWN) creates the #planWrap slot the renderer fills
  fe.renderCard({ severity: "URGENT", action: "Give ciprofloxacin", red_flags: [] }, "DYSENTERY");
  fe.renderPlan({
    medicines: [{ name: "Ciprofloxacin", citation: { doc: "WHO IMCI Chart Booklet (2014)", page: 7 }, bands: [{ band: "5 - <10 kg", dose: "1/2 tablet" }] }],
    supportive: [{ item: "Give paracetamol every 6 hours", citation: { doc: "WHO IMCI Chart Booklet (2014)", page: 17 } }],
    home_care: [],
    return_now: [{ sign: "Not able to drink or breastfeed", citation: { doc: "WHO IMCI Chart Booklet (2014)", page: 43 } }],
    follow_up: { when: "Follow-up in 3 days", detail: "Check the child for general danger signs", citation: { doc: "WHO IMCI Chart Booklet (2014)", page: 8 } },
    referral: null,
  });
  const pw = dom.window.document.getElementById("planWrap")!.innerHTML;
  assert.match(pw, /Ciprofloxacin/);
  assert.match(pw, /class="dose"/, "per-band dose table rendered");
  assert.match(pw, /Give paracetamol every 6 hours/);
  assert.match(pw, /Not able to drink or breastfeed/);
  assert.match(pw, /At the visit: Check the child for general danger signs/);
});

test("handleEvent dispatches citation then card (citation-first SSE order)", () => {
  const doc = dom.window.document;
  doc.getElementById("citationBox")!.innerHTML = "";
  fe.handleEvent("event: citation\ndata: " + JSON.stringify({ protocol: "IMCI", doc: "WHO IMCI Chart Booklet (2014)", page: 7, section: "DYSENTERY Give ciprofloxacin", score: 0.8, retrieval: "semantic" }));
  // The citation names its corpus (IMCI vs mhGAP) from the event's `protocol` field.
  assert.match(doc.getElementById("citationBox")!.innerHTML, /From the WHO IMCI guideline/);
  fe.handleEvent("event: card\ndata: " + JSON.stringify({ card: { severity: "URGENT", action: "Give ciprofloxacin", red_flags: [] }, classification: "DYSENTERY" }));
  assert.match(card(), /DYSENTERY/);
  assert.match(card(), /sev URGENT/);
});

test("handleEvent ignores keep-alive comment frames and malformed JSON", () => {
  assert.doesNotThrow(() => fe.handleEvent(": keep-alive"));
  assert.doesNotThrow(() => fe.handleEvent("event: card\ndata: {not json"));
});

// ── H-1 / H-2 (Phase 5b) ─────────────────────────────────────────────────────────────
const doc = dom.window.document;
const el = (id: string) => doc.getElementById(id)!;

test("H-1: first_token advances the staged reasoning label", () => {
  el("reasonLabel").textContent = "Reading the matched guideline";
  fe.handleEvent("event: first_token\ndata: " + JSON.stringify({ ttftMs: 1200 }));
  assert.equal(el("reasonLabel").textContent, "Reasoning through the protocol");
  assert.equal(el("hTtft").textContent, "1.2 s");
});

test("H-1: reason timer counts whole seconds up and clears on stop", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  try {
    fe.startReasonTimer();
    mock.timers.tick(1000);
    assert.equal(el("reasonTimer").textContent, "· 1s");
    mock.timers.tick(2000);
    assert.equal(el("reasonTimer").textContent, "· 3s");
    fe.stopReasonTimer();
    assert.equal(el("reasonTimer").textContent, "", "timer text cleared on stop");
  } finally {
    mock.timers.reset();
  }
});

test("H-2: Stop aborts the in-flight assessment, restores the button, and is re-entrancy-guarded", async () => {
  let fetchCalls = 0;
  // Abort-aware fetch stub: parks until the AbortController fires, then rejects with an AbortError
  // (mirrors what the browser fetch does on signal.abort()).
  g.fetch = (_url: string, opts: { signal: AbortSignal }) => {
    fetchCalls++;
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        (e as { name: string }).name = "AbortError";
        reject(e);
      });
    });
  };
  (el("case") as unknown as { value: string }).value = "child with a cough and fast breathing, alert";
  const assess = el("assess");
  const origLabel = assess.innerHTML;

  const p = fe.runAssess();          // parks on the pending fetch (do NOT await yet)
  await Promise.resolve();           // let runAssess reach the fetch await
  await fe.runAssess();              // second call must be guarded out while the first is in flight
  assert.equal(fetchCalls, 1, "re-entrancy guard blocks the second run");
  assert.match(assess.innerHTML, /Stop/, "button is in Stop mode during the run");
  assert.match(assess.className, /is-stopping/, "neutral Stop styling applied");

  (assess as unknown as { onclick: () => void }).onclick();  // click Stop → abort
  await p;                            // abort propagates through catch + finally

  assert.equal(el("status").textContent, "Stopped.", "abort shows a calm Stopped., not an error");
  assert.equal(el("err").textContent, "", "no error text on a user Stop");
  assert.equal(assess.innerHTML, origLabel, "button label restored after Stop");
  assert.ok(!/is-stopping/.test(assess.className), "Stop styling removed after finish");
  assert.match(el("reasoningWrap").className, /hidden/, "reasoning box hidden after Stop");
});
