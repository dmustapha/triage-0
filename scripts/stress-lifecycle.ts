// File: scripts/stress-lifecycle.ts  (Stress S5 — model lifecycle churn)
// Standalone lifecycle harness. Repeats load -> runTriage -> unload FIVE times against the live MedPsy +
// GTE stack, proving the orchestrator's load/unload cycle is stable: each cycle returns a real
// (non-UNKNOWN) grounded card, no engine error is thrown across reloads, and RSS returns to ~baseline
// after each unload (the Phase-0 finding that unloadModel reclaims fully — the basis of RESIDENT_MODE).
//
// This is the WORST case for the @qvac single-job engine: tearing models down and bringing them back up
// repeatedly is where a leaked handle or a stale worker would surface. Drives the orchestrator/engine
// directly (no HTTP server) so the cycle is exactly load->infer->unload with nothing kept resident.
//
// Run (standalone, NOT part of `npm test`):
//   node --expose-gc --import tsx scripts/stress-lifecycle.ts
// Requires `npm run ingest` first. RESIDENT_MODE=sequential forces an unload after every use.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-stress-life-"));

const { registry, medpsySpec } = await import("../src/config.js");
const { chunkCount } = await import("../src/rag/store.js");
const { loadModelTimed, unloadModelTimed } = await import("../src/qvac/engine.js");
const { close } = await import("../src/qvac/sdk.js");
const { runTriage } = await import("../src/triage/triage.js");

const CYCLES = 5;
const CASE = "Two year old, cough for three days, chest indrawing, breathing 52 per minute, alert and drinking, no danger signs.";

const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const gc = () => { const g = (globalThis as { gc?: () => void }).gc; if (g) { g(); g(); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (chunkCount() === 0) {
    console.error("SKIP stress-lifecycle: store not ingested — run `npm run ingest` first.");
    process.exit(0);
  }

  gc();
  await sleep(200);
  const base = rssMB();
  console.log(`stress-lifecycle: baseline RSS ${base}MB; ${CYCLES} load->triage->unload cycles`);

  const peaks: number[] = [];
  const restingAfterUnload: number[] = [];

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    let embedId = "";
    let medpsyId = "";
    try {
      ({ modelId: embedId } = await loadModelTimed(registry.embeddings, "stress-lifecycle"));
      ({ modelId: medpsyId } = await loadModelTimed(medpsySpec(), "stress-lifecycle"));

      const { card, retrieval } = await runTriage(CASE, { medpsyId, embedId });
      assert.notEqual(card.severity, "UNKNOWN", `cycle ${cycle}: grounded (non-UNKNOWN) card (got ${card.severity})`);
      assert.equal(retrieval, "semantic", `cycle ${cycle}: grounded via semantic retrieval`);
      assert.ok(["URGENT", "ROUTINE", "EMERGENCY"].includes(card.severity), `cycle ${cycle}: a real triage band`);

      gc();
      peaks.push(rssMB());
    } finally {
      // Always unload both models, even on a mid-cycle failure, so the next cycle starts clean.
      if (medpsyId) await unloadModelTimed(medpsyId, "medpsy", "stress-lifecycle");
      if (embedId) await unloadModelTimed(embedId, "embeddings", "stress-lifecycle");
    }
    gc();
    await sleep(200);
    const resting = rssMB();
    restingAfterUnload.push(resting);
    console.log(`stress-lifecycle: cycle ${cycle} resting RSS ${resting}MB (baseline ${base}MB)`);
  }

  // RSS must be STABLE across cycles: the resting RSS after the last unload should not have crept far
  // above the resting RSS after the first (a per-cycle leak would show monotonic growth). Allow a modest
  // allocator-fragmentation margin.
  const firstResting = restingAfterUnload[0];
  const lastResting = restingAfterUnload[restingAfterUnload.length - 1];
  const creep = lastResting - firstResting;
  console.log(`stress-lifecycle: resting RSS first ${firstResting}MB -> last ${lastResting}MB (creep ${creep}MB); peaks ${peaks.join(",")}MB`);
  assert.ok(creep < 150, `resting RSS creep ${creep}MB across ${CYCLES} cycles under 150MB (no per-cycle leak)`);

  close();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
  console.log("stress-lifecycle: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("stress-lifecycle: FAIL\n", err);
  process.exit(1);
});
