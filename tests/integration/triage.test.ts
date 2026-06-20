// File: tests/integration/triage.test.ts
// THE triage-output correctness gate (the deferred patient-facing check). Unlike grounding.test.ts
// (which proves the right disposition is RETRIEVABLE), this proves the full triage PIPELINE emits a
// card whose SEVERITY is clinically correct, end-to-end, on the live MedPsy + RAG stack.
//
// Hero invariant: a chest-indrawing PNEUMONIA case must NOT be classified EMERGENCY (the 2014 IMCI
// merge — home oral amoxicillin), while a genuine danger-sign case MUST be EMERGENCY, and an
// off-domain case must ABSTAIN (UNKNOWN, no invented citation).
//
// Requires `npm run ingest` first. Loads BOTH GTE embeddings + MedPsy-1.7B. SLOW (each case runs a
// reason + extract pass, ~20-40s). Self-skips if the store is not ingested.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));

const { registry, medpsySpec } = await import("../../src/config.js");
const { chunkCount } = await import("../../src/rag/store.js");
const { loadModelTimed, unloadModelTimed } = await import("../../src/qvac/engine.js");
const { close } = await import("../../src/qvac/sdk.js");
const { runTriage } = await import("../../src/triage/triage.js");

const ingested = chunkCount() > 0;
const skip = ingested ? false : "store not ingested — run `npm run ingest` first";

/**
 * Task #22 invariant check, done at the structural level the test can see: every plan line MUST carry a
 * real citation (a doc + a numeric page). The verbatim-grounding of each line against a retrieved chunk
 * is enforced deterministically in triage.ts groundPlan(); here we prove the wiring surfaces grounded,
 * cited components and never an uncited line. Returns the number of grounded lines across the plan.
 */
function assertPlanCited(plan: any): number {
  assert.ok(plan, "card.plan is attached");
  let lines = 0;
  const checkCite = (c: any, where: string) => {
    assert.ok(c && c.doc && String(c.doc).length > 0, `${where}: citation has a doc`);
    assert.ok(String(c.page).match(/\d/), `${where}: citation has a real page (got ${c?.page})`);
    lines++;
  };
  for (const m of plan.medicines) {
    assert.ok(m.name && m.name.length > 0, "medicine has a name");
    checkCite(m.citation, `medicine ${m.name}`);
  }
  for (const s of plan.supportive) { assert.ok(s.item?.length > 0); checkCite(s.citation, "supportive"); }
  for (const h of plan.home_care) { assert.ok(h.advice?.length > 0); checkCite(h.citation, "home_care"); }
  for (const r of plan.return_now) { assert.ok(r.sign?.length > 0); checkCite(r.citation, "return_now"); }
  if (plan.follow_up) { assert.ok(plan.follow_up.when?.length > 0); checkCite(plan.follow_up.citation, "follow_up"); }
  if (plan.referral) { assert.ok(plan.referral.criterion?.length > 0); checkCite(plan.referral.citation, "referral"); }
  return lines;
}

let embedId = "";
let medpsyId = "";

before(async () => {
  if (!ingested) return;
  ({ modelId: embedId } = await loadModelTimed(registry.embeddings, "test"));
  ({ modelId: medpsyId } = await loadModelTimed(medpsySpec(), "test"));
});
after(async () => {
  if (medpsyId) await unloadModelTimed(medpsyId, "medpsy", "test");
  if (embedId) await unloadModelTimed(embedId, "embeddings", "test");
  close();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

test("HERO: chest-indrawing pneumonia is NOT EMERGENCY (2014 home-treatment disposition)", { skip, timeout: 240_000 }, async () => {
  const { card, citationChunk, retrieval } = await runTriage(
    "Two year old, cough for three days, chest indrawing, breathing 52 per minute, alert and drinking, no danger signs.",
    { medpsyId, embedId },
  );
  assert.equal(retrieval, "semantic", "grounded via semantic retrieval");
  // The whole point: the pre-2014 model bias (indrawing = severe = refer) must NOT win. URGENT/ROUTINE ok.
  assert.notEqual(card.severity, "EMERGENCY", `severity must not be EMERGENCY for home-treatment pneumonia (got ${card.severity}, action="${card.action}")`);
  assert.ok(["URGENT", "ROUTINE"].includes(card.severity), `PNEUMONIA-equivalent band (got ${card.severity})`);
  // Citation must be a REAL retrieved IMCI chunk, never invented.
  assert.ok(citationChunk, "has a grounding chunk");
  assert.equal(citationChunk!.protocol, "IMCI");
  assert.match(card.protocol_citation.doc, /IMCI/i);
  assert.ok(String(card.protocol_citation.page).match(/\d/), "citation has a real page");
  assert.ok(card.protocol_citation.section.length > 0, "citation has a section anchor");
  assert.ok(card.action.length > 0 && card.reasoning.length > 0);

  // Task #22: a structured, fully-cited management plan beyond the single classification line.
  const grounded = assertPlanCited(card.plan);
  assert.ok(grounded >= 1, "the plan surfaces at least one grounded, cited component");
  assert.ok(card.plan!.medicines.length >= 1, "PNEUMONIA renders at least one medicine");
  const names = card.plan!.medicines.map((m) => m.name.toLowerCase()).join(" ");
  assert.match(names, /amoxicillin/, `the canonical PNEUMONIA drug is surfaced (got medicines="${names}")`);
  // Doses are weight-band guidance, NEVER a fabricated single amount.
  for (const m of card.plan!.medicines) {
    if (m.dose) assert.equal(m.dose, "By weight band", "dose is banded guidance, not a fabricated mg/ml");
  }
});

test("danger-sign case IS EMERGENCY (and the plan carries referral)", { skip, timeout: 240_000 }, async () => {
  const { card } = await runTriage(
    "Eleven month old with cough, now lethargic and unable to drink, breathing 60 per minute with chest indrawing, and stridor while calm.",
    { medpsyId, embedId },
  );
  assert.equal(card.severity, "EMERGENCY", `genuine danger signs must escalate (got ${card.severity}, action="${card.action}")`);
  // A severe disposition must surface the referral / first-dose plan, all cited.
  const grounded = assertPlanCited(card.plan);
  assert.ok(grounded >= 1, "the severe plan surfaces at least one grounded, cited component");
  assert.ok(card.plan!.referral !== null, `a severe case surfaces a referral instruction (plan=${JSON.stringify(card.plan)})`);
});

test("mhGAP adult depression: a cited, multi-component plan from the mhGAP corpus", { skip, timeout: 240_000 }, async () => {
  const { card } = await runTriage(
    "Adult with low mood, loss of interest, poor sleep and appetite for the past three weeks.",
    { medpsyId, embedId },
  );
  assert.notEqual(card.severity, "UNKNOWN", `mhGAP depression must ground, not abstain (got ${card.severity})`);
  const grounded = assertPlanCited(card.plan);
  assert.ok(grounded >= 1, "the depression plan surfaces at least one grounded, cited component");
  // At least one plan line should cite the mhGAP guide (the mental-health source), proving cross-corpus
  // component retrieval, not just the IMCI chart.
  const allCites = [
    ...card.plan!.medicines.map((m) => m.citation),
    ...card.plan!.supportive.map((s) => s.citation),
    ...card.plan!.home_care.map((h) => h.citation),
    ...card.plan!.return_now.map((r) => r.citation),
    ...(card.plan!.follow_up ? [card.plan!.follow_up.citation] : []),
    ...(card.plan!.referral ? [card.plan!.referral.citation] : []),
  ];
  assert.ok(allCites.some((c) => /mhGAP/i.test(String(c.doc))), `a plan line cites the mhGAP guide (cites=${JSON.stringify(allCites)})`);
});

test("off-domain case ABSTAINS (UNKNOWN, no invented citation)", { skip, timeout: 120_000 }, async () => {
  const { card, citationChunk, retrieval } = await runTriage(
    "What is the best recipe for a chocolate cake?",
    { medpsyId, embedId },
  );
  assert.equal(retrieval, "abstain", "below the retrieval threshold → abstain before the model is called");
  assert.equal(card.severity, "UNKNOWN");
  assert.equal(citationChunk, null, "no citation chunk when abstaining");
  assert.match(card.protocol_citation.doc, /no protocol/i, "citation is the explicit no-match, not a fabricated source");
});
