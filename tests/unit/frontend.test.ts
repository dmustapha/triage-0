// File: tests/unit/frontend.test.ts
// jsdom unit tests for the front-end render/parse logic in public/assets/js/triage.js.
// triage.js is a browser IIFE; it exposes its pure functions via a browser-safe `module.exports`
// hook (a no-op in the browser). We stand up a jsdom DOM with the app's element IDs, stub fetch +
// matchMedia, then require the script (which runs its harmless auto-wiring) and exercise the renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - jsdom ships no bundled types; tests/ is outside the build-gate tsconfig anyway.
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

// Element IDs the app wiring + renderers touch (planWrap is created INSIDE #card by renderCard).
const IDS = [
  "seeds", "case", "rec", "status", "citationBox", "reasoning", "reasoningWrap",
  "reasonLabel", "card", "err", "result", "hTtft", "hTps", "hDev", "hChunks", "net", "assess",
];
const dom = new JSDOM(`<!DOCTYPE html><body>${IDS.map((id) => `<div id="${id}"></div>`).join("")}</body>`, {
  url: "http://localhost:3010/app",
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// (navigator is getter-only on the Node global and is only read in the click handler, never at import)
(dom.window as unknown as Record<string, unknown>).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
g.fetch = async () => ({ json: async () => ({ chunks: 994, residentMode: "resident", medpsy: "1.7b" }), headers: { get: () => null } });

const require = createRequire(import.meta.url);
const fe = require("../../public/assets/js/triage.js") as {
  esc: (s: string) => string;
  doseTable: (b: { band: string; dose: string }[]) => string;
  renderCard: (card: Record<string, unknown>, classification: string) => void;
  renderPlan: (plan: Record<string, unknown>) => void;
  handleEvent: (block: string) => void;
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
  assert.match(doc.getElementById("citationBox")!.innerHTML, /From the WHO guide/);
  fe.handleEvent("event: card\ndata: " + JSON.stringify({ card: { severity: "URGENT", action: "Give ciprofloxacin", red_flags: [] }, classification: "DYSENTERY" }));
  assert.match(card(), /DYSENTERY/);
  assert.match(card(), /sev URGENT/);
});

test("handleEvent ignores keep-alive comment frames and malformed JSON", () => {
  assert.doesNotThrow(() => fe.handleEvent(": keep-alive"));
  assert.doesNotThrow(() => fe.handleEvent("event: card\ndata: {not json"));
});
