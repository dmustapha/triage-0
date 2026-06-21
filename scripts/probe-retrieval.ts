// Fast retrieval diagnostic (embeddings only). For each case prints top-K chunks (page + score) so we
// can see whether the right page is retrievable and where it sits vs the abstain threshold.
// Run: lsof -ti:3010 | xargs kill -9; npx tsx scripts/probe-retrieval.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-probe-"));

const { registry, config } = await import("../src/config.js");
const { loadModelTimed, unloadModelTimed } = await import("../src/qvac/engine.js");
const { close } = await import("../src/qvac/sdk.js");
const { search } = await import("../src/rag/store.js");

const CASES: [string, string][] = [
  ["malnutrition (MUAC 110)", "18 month old, very thin, arm-circumference 110 mm, no swelling of the feet, alert, eating a little."],
  ["malnutrition (oedema)", "Child very thin and wasted with swelling of both feet, not eating."],
  ["persistent diarrhoea", "Diarrhoea for 3 weeks, child thin, no blood, still drinking."],
  ["newborn jaundice", "Newborn 5 days old, yellow skin and eyes, feeding poorly."],
  ["substance withdrawal", "Adult confused and seeing things after drinking heavily for years then stopping two days ago."],
  ["dementia", "Elderly person increasingly forgetful, getting lost, repeating questions."],
  ["adult OB (off-scope)", "My 30 year old wife has severe abdominal pain and missed her period."],
  ["off-domain cake", "What is the best recipe for a chocolate cake?"],
];

const { modelId: embedId } = await loadModelTimed(registry.embeddings, "test");
console.error(`threshold = ${config.ragScoreThreshold}`);
for (const [label, q] of CASES) {
  const hits = await search({ embedModelId: embedId, queryText: q.slice(0, 1500), k: 6, phase: "triage" });
  const top = hits[0]?.score ?? 0;
  console.error(`\n### ${label}  (top ${top.toFixed(3)} ${top >= config.ragScoreThreshold ? "GROUND" : "ABSTAIN"})`);
  for (const h of hits.slice(0, 5)) console.error(`  ${h.score.toFixed(3)}  ${h.protocol}|p${h.citation.page}  "${h.text.replace(/\s+/g, " ").slice(0, 64)}"`);
}
await unloadModelTimed(embedId, "embeddings", "test");
close();
