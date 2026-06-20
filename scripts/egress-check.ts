// File: scripts/egress-check.ts
// Demo + audit: warm the models, then run a full triage with the egress guard armed and print whether
// ANY outbound connection was attempted. Use this on camera (and in the submission) to prove the
// "network monitor at zero" claim from the code side.
//
// Run: node --import tsx scripts/egress-check.ts
import { registry, medpsySpec } from "../src/config.js";
import { loadModelTimed, unloadModelTimed } from "../src/qvac/engine.js";
import { close } from "../src/qvac/sdk.js";
import { runTriage } from "../src/triage/triage.js";
import { guard } from "../src/qvac/egress-guard.js";

const CASE = "2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs.";

async function main() {
  console.log("Warming model cache (the one disclosed first-run download lives here, outside the claim)…");
  const { modelId: embedId } = await loadModelTimed(registry.embeddings, "egress-check");
  const { modelId: medpsyId } = await loadModelTimed(medpsySpec(), "egress-check");

  console.log("Cache warm. Arming egress guard and running a FULL triage…\n");
  guard.arm();
  let card;
  try {
    ({ card } = await runTriage(CASE, { medpsyId, embedId }));
  } finally {
    guard.disarm();
  }

  console.log(`Triage produced: ${card.severity} — ${card.action}`);
  console.log(`Cited: ${card.protocol_citation.doc} p.${card.protocol_citation.page}\n`);

  if (guard.violations.length === 0) {
    console.log("✅ ZERO outbound network connections during inference. The case never left the device.");
  } else {
    console.log(`❌ ${guard.violations.length} egress attempt(s) during inference:`);
    for (const v of guard.violations) console.log(`   - ${v.kind} -> ${v.target}`);
  }

  await unloadModelTimed(medpsyId, "medpsy", "egress-check");
  await unloadModelTimed(embedId, "embeddings", "egress-check");
  close();
  process.exit(guard.violations.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error("egress-check failed:", e); try { close(); } catch {} process.exit(1); });
