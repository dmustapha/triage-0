// File: tests/integration/offline-egress.test.ts
// E2 — the headline thesis proof (PLAN Phase 5). After the model cache is warm, a FULL triage must
// make ZERO outbound network connections: the patient's case never leaves the device. We warm the
// models (load is excluded from the claim — that's where the one disclosed first-run download lives),
// then arm the egress guard, run a real runTriage, and assert no external host was contacted while a
// valid grounded card was produced (so we know inference actually ran, not a no-op).
//
// Loads MedPsy + GTE. SLOW. Self-skips if the store isn't ingested.
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
const { guard } = await import("../../src/qvac/egress-guard.js");

const skip = chunkCount() > 0 ? false : "store not ingested — run `npm run ingest` first";
let embedId = "";
let medpsyId = "";

before(async () => {
  if (skip) return;
  // Warm the cache BEFORE arming — model load is the one disclosed network event, outside the claim.
  ({ modelId: embedId } = await loadModelTimed(registry.embeddings, "test"));
  ({ modelId: medpsyId } = await loadModelTimed(medpsySpec(), "test"));
});
after(async () => {
  guard.disarm();
  if (medpsyId) await unloadModelTimed(medpsyId, "medpsy", "test");
  if (embedId) await unloadModelTimed(embedId, "embeddings", "test");
  close();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

test("a full triage makes ZERO outbound network connections (warm cache)", { skip, timeout: 240_000 }, async () => {
  guard.arm();
  let card;
  try {
    const result = await runTriage(
      "2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs.",
      { medpsyId, embedId },
    );
    card = result.card;
  } finally {
    guard.disarm();
  }
  // Inference really happened (not a short-circuit): a grounded, schema-valid card.
  assert.ok(card, "produced a card");
  assert.notEqual(card!.severity, "UNKNOWN", "the triage actually ran end-to-end (not an abstain)");
  // The whole point: no external host was contacted during the triage.
  assert.deepEqual(
    guard.violations,
    [],
    `expected zero egress during inference, but saw: ${guard.violations.map((v) => `${v.kind}:${v.target}`).join(", ")}`,
  );
});

test("the guard itself catches a deliberate external connection (control)", { skip: false, timeout: 20_000 }, async () => {
  // Negative control: prove the guard is not a no-op — an intentional external lookup must be recorded.
  const { promises: dnsp } = await import("node:dns");
  guard.arm();
  try {
    await dnsp.lookup("example.com").catch(() => {});
  } finally {
    guard.disarm();
  }
  assert.ok(
    guard.violations.some((v) => v.target.includes("example.com")),
    "guard must record a real external lookup (else the main test proves nothing)",
  );
});
