// Integration test: proves RAG grounding against the REAL ingested WHO corpus.
// Expected values are INDEPENDENT of our corpus — they come from the authoritative WHO IMCI 2014
// standard (the clinical fact-check), NOT from text we wrote. This is what de-circularizes the
// old "4/4" gate: a corpus serving wrong medicine (e.g. chest indrawing -> severe) would now FAIL.
//
// Requires `npm run ingest` first (loads the GTE embeddings model + queries ~/.qvac/rag-hyperdb).
// Self-skips if the store is not ingested. Slow (~30-60s) — generous timeout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));

const { config, registry } = await import("../../src/config.js");
const { chunkCount, search } = await import("../../src/rag/store.js");
const { loadModelTimed, unloadModelTimed } = await import("../../src/qvac/engine.js");
const { close } = await import("../../src/qvac/sdk.js");

const ingested = chunkCount() > 0;
const skip = ingested ? false : "store not ingested — run `npm run ingest` first";
let modelId = "";

before(async () => {
  if (ingested) ({ modelId } = await loadModelTimed(registry.embeddings, "test"));
});
after(async () => {
  if (modelId) await unloadModelTimed(modelId, "embeddings", "test");
  close();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

// Independent expectations sourced from WHO IMCI Chart Booklet 2014 + mhGAP v2.0.
const POSITIVES = [
  {
    label: "pneumonia: chest indrawing -> PNEUMONIA (home amoxicillin), NOT severe",
    q: "two year old child with chest indrawing and fast breathing 52 per minute and cough",
    protocol: "IMCI",
    // The CORRECT 2014 disposition. A pre-2014 corpus (indrawing=severe) would not surface this.
    content: /pneumonia|amoxicillin/i,
  },
  {
    label: "general danger signs",
    q: "child not able to drink vomits everything had convulsions lethargic or unconscious",
    protocol: "IMCI",
    content: /danger sign|unable|not able to drink|convuls|refer/i,
  },
  {
    label: "dehydration",
    q: "child with diarrhoea, sunken eyes, and skin pinch goes back very slowly",
    protocol: "IMCI",
    content: /dehydration|skin pinch|sunken|plan/i,
  },
  {
    label: "depression (mhGAP)",
    q: "adult with depressed mood, loss of interest, and sleep disturbance for two weeks",
    protocol: "mhGAP",
    content: /depress|interest|mood/i,
  },
];

// Broadened negative controls (RR6) — threshold 0.70 is provisional, calibrated on a small set;
// more off-domain queries here make the boundary harder to pass by luck.
const NEGATIVES = [
  "how to file taxes online",
  "best way to repair a car engine",
  "recipe for chocolate cake",
  "cheapest flights to tokyo next month",
  "javascript async await tutorial",
  "who won the football match yesterday",
];

for (const p of POSITIVES) {
  test(`grounding+ ${p.label}`, { skip, timeout: 180_000 }, async () => {
    const hits = await search({ embedModelId: modelId, queryText: p.q, k: 5, phase: "test" });
    const top = hits[0];
    assert.ok(top, "got at least one hit");
    assert.equal(top.protocol, p.protocol, `routed to ${p.protocol} (got ${top.protocol})`);
    assert.ok(top.score >= config.ragScoreThreshold, `top score ${top.score.toFixed(3)} >= threshold ${config.ragScoreThreshold}`);
    assert.ok(hits.slice(0, 5).some((h) => p.content.test(h.text)), `top-5 contains the expected clinical content ${p.content}`);
    // citation faithfulness: real page metadata from the sidecar, not the degraded fallback.
    assert.ok(top.citation.page > 0, "citation has a real page number");
    assert.doesNotMatch(top.citation.title, /unavailable/i, "citation is not the degraded fallback");
    assert.equal(top.mode, "semantic");
  });
}

// CORRECTNESS gate (RR2): proves the corpus encodes the *2014* disposition, not just any pneumonia
// text. The 2014 revision MERGED chest indrawing into PNEUMONIA (home oral amoxicillin). So a
// single retrieved chunk must co-locate "chest indrawing" + "PNEUMONIA" + "amoxicillin". A pre-2014
// corpus (indrawing = SEVERE, referral) would NEVER pair indrawing with amoxicillin in one chunk —
// this is the assertion my earlier loose /pneumonia/ regex failed to make.
test("grounding correctness: chest-indrawing retrieves the 2014 PNEUMONIA+amoxicillin disposition", { skip, timeout: 180_000 }, async () => {
  const hits = await search({
    embedModelId: modelId,
    queryText: "two year old child with chest indrawing and fast breathing and cough",
    k: 5,
    phase: "test",
  });
  const correct = hits.some(
    (h) => /chest indrawing/i.test(h.text) && /\bpneumonia\b/i.test(h.text) && /amoxicillin/i.test(h.text),
  );
  assert.ok(
    correct,
    "no retrieved chunk co-locates chest indrawing + PNEUMONIA + amoxicillin (the correct 2014 home-treatment disposition)",
  );
});

test("grounding- off-domain queries do NOT cross the threshold (no false grounding)", { skip, timeout: 180_000 }, async () => {
  const offenders: string[] = [];
  for (const q of NEGATIVES) {
    const hits = await search({ embedModelId: modelId, queryText: q, k: 1, phase: "test" });
    if (hits[0].score >= config.ragScoreThreshold) offenders.push(`${q} (${hits[0].score.toFixed(3)})`);
  }
  assert.equal(offenders.length, 0, `off-domain queries crossed the ${config.ragScoreThreshold} threshold: ${offenders.join("; ")}`);
});
