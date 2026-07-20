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
const { orchestrator } = await import("../../src/qvac/orchestrator.js");
const { translations } = await import("../../src/config.js");

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
let translationReady = false; // Phase 4: true iff the Bergamot fr>en model is available (cached / fetchable).

before(async () => {
  if (!ingested) return;
  ({ modelId: embedId } = await loadModelTimed(registry.embeddings, "test"));
  ({ modelId: medpsyId } = await loadModelTimed(medpsySpec(), "test"));
  // Warm one translation direction so the round-trip test can soft-skip when models are absent (offline).
  try {
    await orchestrator.ensure(translations["fr>en"], "test");
    translationReady = true;
  } catch {
    translationReady = false;
  }
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

// Phase 4 multilingual round-trip: a French pneumonia case is translated to English, routed on the same
// English stack, then the card is translated back to French with the English WHO citation kept. Expected
// values are from the WHO rule for the (translated) case — NOT observed. Soft-skips if Bergamot is absent.
test("multilingual: FR pneumonia routes to PNEUMONIA and the card round-trips to French", { skip, timeout: 240_000 }, async () => {
  if (!translationReady) { console.log("  (skipped: Bergamot fr>en model unavailable)"); return; }
  const { card, classification } = await runTriage(
    "Enfant de 2 ans, toux depuis 3 jours, respiration rapide à 54 par minute, tirage sous-costal, éveillé et boit bien, aucun signe de danger.",
    { medpsyId, embedId },
  );
  // Routing (English internally) → WHO PNEUMONIA (fast breathing 54/min, no danger sign) at URGENT.
  assert.match(String(classification).toUpperCase(), /^PNEUMONIA$/, `FR pneumonia routes to PNEUMONIA (got ${classification})`);
  assert.equal(card.severity, "URGENT");
  // Output round-trip: flagged translated, source French, action rendered in French, citation kept English.
  assert.equal(card.source_language, "fr");
  assert.equal(card.translated, true);
  assert.match(card.action, /amoxicilline|jour|orale/i, `action is French (got "${card.action}")`);
  assert.match(card.protocol_citation.doc, /IMCI/i, "the WHO citation stays English for provenance");
  // The full PLAN (not just the card) must translate — this is what the single-job concurrency bug broke.
  // Assert a translated medicine name AND that DOSE NUMBERS survive machine translation intact (the clinical
  // safety property behind the owner's "full plan translated, doses included" choice).
  const meds = card.plan?.medicines ?? [];
  assert.ok(meds.length >= 1, "the FR pneumonia plan carries a medicine");
  const amox = meds.find((m) => /amoxicillin?e/i.test(m.name));
  assert.ok(amox, `a medicine is French amoxicilline (got ${JSON.stringify(meds.map((m) => m.name))})`);
  // Every mg/ml/kg number and tablet/ml count from the WHO weight-band table must be preserved verbatim.
  const doseText = [amox!.strength, amox!.frequency, ...(amox!.bands ?? []).flatMap((b) => [b.band, b.dose])].filter(Boolean).join(" ");
  assert.match(doseText, /\b250\b/, `the 250 mg strength survives translation (got "${doseText}")`);
  assert.match(doseText, /\bmg\b/i, "the mg unit survives translation");
  assert.match(doseText, /\b(ml|kg)\b/i, "ml/kg dosing units survive translation");
  assert.match(doseText, /\b5\b/, "the '5 days' / 5 ml numbers survive translation");
  // The per-line citation stays English (provenance), even though the dose text is French.
  assert.match(String(amox!.citation.doc), /IMCI/i, "the medicine citation stays English");
});

// C-4 regression (Phase-7 live-caught): a Spanish "very severe febrile disease" case (high fever + neck
// stiffness + unable to drink) once CRASHED the request with `processPromptImpl: context overflow`. Root
// cause: the reason pass produced a DEGENERATE assessment (its tokens stayed inside <think>, stripThink →
// a near-empty anchor), so the UNCAPPED extract pass ran away (~2000+ tokens) and filled the KV context
// mid-generation. The fix caps the extract (DEFAULT_EXTRACT_PREDICT); the runaway is now truncated and the
// retry loop recovers. This test's LOAD-BEARING assertion is that runTriage COMPLETES (does not throw) —
// with the cap removed it overflows and this fails. Bonus: the deterministic danger-sign gate still forces
// EMERGENCY and the card round-trips to Spanish. Soft-skips if the Bergamot es>en model is unavailable.
test("C-4 regression: ES neck-stiffness danger-sign case does NOT overflow (completes, EMERGENCY, es round-trip)", { skip, timeout: 240_000 }, async () => {
  let esReady = false;
  try { await orchestrator.ensure(translations["es>en"], "test"); esReady = true; } catch { esReady = false; }
  if (!esReady) { console.log("  (skipped: Bergamot es>en model unavailable)"); return; }
  // Before the fix, this line threw CONTEXT_OVERFLOW. The primary guard is simply that it resolves.
  const { card, classification } = await runTriage(
    "Niño de 3 años con fiebre alta, rigidez en el cuello y muy somnoliento, no puede beber.",
    { medpsyId, embedId },
  );
  // "no puede beber" (unable to drink) is a WHO danger sign → the deterministic severity gate forces EMERGENCY.
  assert.equal(card.severity, "EMERGENCY", `ES danger-sign case must escalate (got ${card.severity}, class="${classification}")`);
  assert.notEqual(String(classification).toUpperCase(), "UNKNOWN", `must classify, not abstain (got ${classification})`);
  // Output round-trips to Spanish with the English WHO citation kept for provenance.
  assert.equal(card.source_language, "es");
  assert.equal(card.translated, true);
  assert.match(card.protocol_citation.doc, /IMCI/i, "the WHO citation stays English");
});
