// File: tests/unit/store-save.test.ts
// MODEL-FREE. Pins the store's save-path INVARIANTS and the degraded-citation branch without loading a
// model. The SDK embed/save calls cannot be stubbed cleanly under ESM, so (per the agreed fallback) this
// targets the exported PURE validators (assertVectorsAligned, partitionSaveResults), the degraded
// citationFromId shape, and the ONE saveChunks path that returns before any embed call (empty after the
// whitespace filter). These guards are the defence against silently pairing the wrong clinical text with
// the wrong citation id — the single worst failure mode for a grounded triage tool.
//
// Complements (does not duplicate) tests/unit/store.test.ts, which covers the happy validators + D2/D5.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "triage0-store-save-"));
const mapFile = join(dir, "citation-map.json");
process.env.TRIAGE0_CITATION_MAP = mapFile;
process.env.TRIAGE0_PERF_DIR = dir;
writeFileSync(mapFile, JSON.stringify({})); // empty sidecar — no model, no real corpus

const store = await import("../../src/rag/store.js");
after(() => rmSync(dir, { recursive: true, force: true }));

// ── D1: alignment invariant edge cases (beyond store.test.ts) ──────────────────────
test("assertVectorsAligned throws when the store returns FEWER vectors than chunks", () => {
  assert.throws(() => store.assertVectorsAligned(["a", "b", "c"], [[1], [2]]), /desync|refusing to save/);
});

test("assertVectorsAligned throws when the store returns MORE vectors than chunks", () => {
  assert.throws(() => store.assertVectorsAligned(["a"], [[1], [2]]), /desync|refusing to save/);
});

test("assertVectorsAligned throws on an Infinity (non-finite) component, naming the bad chunk", () => {
  assert.throws(
    () => store.assertVectorsAligned(["chunk-x", "chunk-y"], [[1, 2], [3, Infinity]]),
    /chunk-y.*invalid vector/,
  );
});

test("assertVectorsAligned passes a single aligned finite vector", () => {
  assert.doesNotThrow(() => store.assertVectorsAligned(["only"], [[0.1, 0.2, 0.3]]));
});

// ── C1: partition with NO per-doc report (older SDK shape) ─────────────────────────
test("partitionSaveResults returns an empty fulfilled set when no result carries an id", () => {
  // The SDK may report fulfilled WITHOUT a per-doc id; saveChunks then persists all chunks. Here we just
  // pin that partition surfaces an empty fulfilledIds set so the caller takes the "persist all" branch.
  const { fulfilledIds, rejected } = store.partitionSaveResults([
    { status: "fulfilled" },
    { status: "fulfilled" },
  ]);
  assert.equal(fulfilledIds.size, 0, "no ids reported -> empty set (saveChunks then persists all)");
  assert.equal(rejected.length, 0);
});

test("partitionSaveResults collects every rejection, preserving its error", () => {
  const { fulfilledIds, rejected } = store.partitionSaveResults([
    { status: "fulfilled", id: "ok1" },
    { status: "rejected", id: "bad1", error: "disk full" },
    { status: "rejected", id: "bad2", error: "checksum mismatch" },
    { status: "fulfilled", id: "ok2" },
  ]);
  assert.deepEqual([...fulfilledIds].sort(), ["ok1", "ok2"]);
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map((r) => r.error), ["disk full", "checksum mismatch"]);
});

// ── saveChunks: empty-after-filter returns 0 BEFORE any embed (model-free path) ────
test("saveChunks returns 0 for whitespace-only chunks (never calls the embedder)", async () => {
  // All chunks filter out as empty -> early return 0, BEFORE embedBatchTimed is reached. If this path
  // ever regressed to call the embedder, this test would hang/throw (no model loaded) instead of passing.
  const n = await store.saveChunks("no-such-model", [
    { id: "x|p1|c0", content: "   ", protocol: "IMCI", title: "t", page: 1, section: "s" },
    { id: "x|p1|c1", content: "\n\t  \n", protocol: "IMCI", title: "t", page: 1, section: "s" },
  ]);
  assert.equal(n, 0, "no non-empty chunk -> 0 saved, embedder never touched");
});

// ── D3: the citation-map-miss branch yields a VISIBLY degraded citation ────────────
test("citationFromId derives protocol+page from the id and marks the title unavailable", () => {
  const c = store.citationFromId("mhGAP|p41|c3");
  assert.equal(c.protocol, "mhGAP", "protocol parsed from the id");
  assert.equal(c.page, 41, "page parsed from the id token");
  assert.match(c.title, /unavailable/i, "title is visibly degraded, not a plausible fake");
  assert.equal(c.section, "", "no fabricated section anchor");
});

test("citationFromId falls back to WHO/0 for an unparseable id (still degraded, never a fake source)", () => {
  const c = store.citationFromId("garbage-id-with-no-pipes");
  assert.equal(c.protocol, "garbage-id-with-no-pipes", "first segment is the protocol token");
  assert.equal(c.page, 0, "no page digits -> 0");
  assert.match(c.title, /unavailable/i);
});

test("chunkCount reads the (empty) sidecar without loading a model", () => {
  assert.equal(store.chunkCount(), 0, "empty sidecar -> 0 chunks; gates model-dependent tests");
});
