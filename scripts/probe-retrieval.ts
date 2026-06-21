// Fast retrieval diagnostic (embeddings only, no MedPsy). For each case prints the top-K chunks with
// page + score, so we can see (a) whether the RIGHT classification page is retrievable at all, and (b)
// the score distribution — to set the abstain threshold so in-domain clears it and off-domain doesn't.
// Run: lsof -ti:3010 | xargs kill -9; npx tsx scripts/probe-retrieval.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-probe-"));

const { registry } = await import("../src/config.js");
const { loadModelTimed, unloadModelTimed } = await import("../src/qvac/engine.js");
const { close } = await import("../src/qvac/sdk.js");
const { search } = await import("../src/rag/store.js");

const CASES: [string, string][] = [
  ["malaria (high-risk no test)", "Three year old, fever for two days, lives in a malaria area, eating normally, no stiff neck, no danger signs."],
  ["pneumonia (fast breathing only)", "Eight month old, cough, breathing 56 per minute, no chest indrawing, alert and feeding."],
  ["severe pneumonia (danger signs)", "One year old with cough, now lethargic and unable to drink, breathing 60 per minute with chest indrawing, and stridor while calm."],
  ["cough/cold", "Three year old, cough and runny nose for two days, no fast breathing, no chest indrawing, playing and eating normally."],
  ["fever no malaria", "Two year old, fever for one day, malaria test negative, has a cough and sore throat, alert and drinking."],
  ["no dehydration", "Three year old, mild diarrhoea for one day, drinking normally, eyes not sunken, alert, skin pinch normal."],
  ["acute ear infection", "Three year old, ear pain for two days, pus draining from the ear for less than fourteen days, no swelling behind the ear."],
  ["psychosis", "Young adult hearing voices and believing neighbours are spying on him, with disorganised speech for one month."],
  ["self-harm", "Adult expressing thoughts of suicide with a plan to harm themselves, found with a self-inflicted wound."],
  ["off-domain cake", "What is the best recipe for a chocolate cake?"],
  ["off-domain car", "My car engine is making a knocking noise, how do I fix it?"],
];

const { modelId: embedId } = await loadModelTimed(registry.embeddings, "test");

for (const [label, q] of CASES) {
  const hits = await search({ embedModelId: embedId, queryText: q.slice(0, 1500), k: 8, phase: "triage" });
  console.log(`\n### ${label}`);
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)}  ${h.protocol}|p${h.citation.page}  "${h.text.replace(/\s+/g, " ").slice(0, 70)}"`);
  }
}

await unloadModelTimed(embedId, "embeddings", "test");
close();
