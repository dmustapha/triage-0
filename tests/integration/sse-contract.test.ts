// File: tests/integration/sse-contract.test.ts
// MODEL-GATED. Pins the /triage SSE WIRE CONTRACT — the exact event order and per-event payload schema
// the frontend (triage.js handleEvent) depends on. server.test.ts proves the hero loop end-to-end; this
// proves the contract is STABLE: citation arrives before reasoning before card before plan before done,
// every event carries its documented fields, and the abstain path emits exactly [abstain, done] with an
// UNKNOWN card and no citation/card/plan.
//
// Self-skips when the store isn't ingested (chunkCount()===0). Loads MedPsy + GTE — SLOW.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));

const { app } = await import("../../src/server.js");
const { orchestrator } = await import("../../src/qvac/orchestrator.js");
const { chunkCount } = await import("../../src/rag/store.js");
const { ManagementPlanSchema } = await import("../../src/triage/schema.js");

const skip = chunkCount() > 0 ? false : "store not ingested — run `npm run ingest` first";

let server: { address(): { port: number } | string | null; close(): void };
let base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((ready) => { server = app.listen(0, () => ready()) as never; });
  const addr = (server as { address(): { port: number } }).address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(async () => {
  if (server) server.close();
  await orchestrator.shutdown();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

/** Read an SSE response body into a list of {event, data} objects (same helper as server.test.ts). */
async function readSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (event && data) out.push({ event, data: JSON.parse(data) });
    }
  }
  return out;
}

const triage = (caseText: string) =>
  fetch(`${base}/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseText }),
  });

test("grounded /triage: full event ORDER citation<first_token<reasoning<card<plan<done", { skip, timeout: 300_000 }, async () => {
  const r = await triage("2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs.");
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const events = await readSse(r);
  const kinds = events.map((e) => e.event);

  const idx = (k: string) => kinds.indexOf(k);
  assert.ok(idx("citation") >= 0, "emits a citation");
  assert.ok(idx("first_token") > idx("citation"), "first_token after citation");
  assert.ok(idx("reasoning") > idx("first_token"), "first reasoning delta after first_token");
  assert.ok(idx("card") > idx("reasoning"), "card after reasoning");
  assert.ok(idx("plan") > idx("card"), "plan after card (progressive enhancement, Task #22)");
  assert.equal(kinds[kinds.length - 1], "done", "done is the terminal event");
  assert.ok(kinds.filter((k) => k === "reasoning").length >= 1, "at least one reasoning delta streamed");
  assert.ok(!kinds.includes("error"), "a grounded case never emits an error event");

  // Representation: additive on-device pipeline readout. Each `stage` marks a REAL step; they are
  // ignorable by any existing consumer and never reorder the load-bearing citation/card/plan sequence.
  const stageKeys = events.filter((e) => e.event === "stage").map((e) => e.data.key);
  for (const s of ["detect", "retrieve", "reason", "classify", "plan"]) {
    assert.ok(stageKeys.includes(s), `stage readout covers the real "${s}" step`);
  }
  assert.ok(idx("stage") >= 0 && idx("stage") < idx("card"), "stages stream before the card they describe");
});

test("grounded /triage: per-event payload SCHEMA (citation / first_token / card / plan)", { skip, timeout: 300_000 }, async () => {
  const events = await readSse(await triage("2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs."));
  const get = (k: string) => events.find((e) => e.event === k)?.data;

  // citation: protocol/doc/page/section/score/retrieval.
  const citation = get("citation");
  assert.ok(citation, "citation present");
  for (const f of ["protocol", "doc", "page", "section", "score", "retrieval"]) {
    assert.ok(f in citation, `citation carries ${f}`);
  }
  assert.equal(typeof citation.score, "number");
  assert.equal(citation.retrieval, "semantic");
  assert.ok(String(citation.page).match(/\d/), "citation page is a real number");

  // first_token: ttftMs number.
  const ft = get("first_token");
  assert.ok(ft && typeof ft.ttftMs === "number" && ft.ttftMs >= 0, "first_token carries a numeric ttftMs");

  // card: card / citationChunk / attempts / perf{ttftMs,tokensPerSec,totalTokens,backendDevice}.
  const cardEv = get("card");
  assert.ok(cardEv, "card present");
  for (const f of ["card", "citationChunk", "attempts", "perf"]) assert.ok(f in cardEv, `card event carries ${f}`);
  assert.equal(typeof cardEv.attempts, "number");
  for (const k of ["ttftMs", "tokensPerSec", "totalTokens", "backendDevice"]) {
    assert.ok(k in cardEv.perf, `perf HUD carries ${k}`);
  }
  assert.ok(cardEv.card.severity && cardEv.card.action, "card has severity + action");

  // plan: must satisfy ManagementPlanSchema.
  const planEv = get("plan");
  assert.ok(planEv && planEv.plan, "plan present");
  const parsed = ManagementPlanSchema.safeParse(planEv.plan);
  assert.ok(parsed.success, `plan matches ManagementPlanSchema (${parsed.success ? "" : JSON.stringify(parsed.error?.issues)})`);
});

test("abstain /triage: [stage(detect), abstain, done], card.severity UNKNOWN, lang set, no citation/card/plan", { skip, timeout: 120_000 }, async () => {
  const events = await readSse(await triage("What is the best recipe for chocolate cake?"));
  const kinds = events.map((e) => e.event);
  // A `detect` stage is emitted before the abstain gate so the readout shows and the abstain localizes;
  // the load-bearing (non-stage) contract stays exactly [abstain, done].
  const nonStage = kinds.filter((k) => k !== "stage");
  assert.deepEqual(nonStage, ["abstain", "done"], "off-domain abstains with abstain then done (stages aside)");
  assert.ok(events.some((e) => e.event === "stage" && e.data.key === "detect"), "detect stage precedes abstain");
  const abstain = events.find((e) => e.event === "abstain")!.data;
  assert.equal(abstain.card.severity, "UNKNOWN");
  assert.equal(abstain.retrieval, "abstain");
  assert.ok("lang" in abstain, "abstain carries lang so the card renders in the case's language");
  assert.ok(!kinds.includes("citation"), "no citation on abstain (nothing matched)");
  assert.ok(!kinds.includes("card"), "no grounded card on abstain");
  assert.ok(!kinds.includes("plan"), "no plan on abstain");
});
