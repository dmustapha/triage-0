// Unit tests for the store's save-path validators (C1/D1) and read-path robustness fixes
// (D2 mtime cache, D3 degraded citation, D5 keyword mode). Uses a temp sidecar via
// TRIAGE0_CITATION_MAP so we never touch the real corpus map. No model is loaded.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "triage0-store-"));
const mapFile = join(dir, "citation-map.json");
process.env.TRIAGE0_CITATION_MAP = mapFile;
process.env.TRIAGE0_PERF_DIR = dir;
writeFileSync(
  mapFile,
  JSON.stringify({
    "IMCI|p6|c1": { id: "IMCI|p6|c1", content: "Chest indrawing or fast breathing PNEUMONIA give oral amoxicillin for 5 days", protocol: "IMCI", title: "WHO IMCI Chart Booklet (2014)", page: 6, section: "Pneumonia" },
    "IMCI|p2|c0": { id: "IMCI|p2|c0", content: "General danger signs not able to drink convulsions lethargic unconscious", protocol: "IMCI", title: "WHO IMCI Chart Booklet (2014)", page: 2, section: "Danger" },
  }),
);

const store = await import("../../src/rag/store.js");
after(() => rmSync(dir, { recursive: true, force: true }));

// ── C1/D1 pure validators ────────────────────────────────────────────────────────
test("assertVectorsAligned throws on vector/chunk desync (D1)", () => {
  assert.throws(() => store.assertVectorsAligned(["a", "b"], [[1, 2]]), /desync/);
});
test("assertVectorsAligned throws on NaN or empty vectors (D1)", () => {
  assert.throws(() => store.assertVectorsAligned(["a"], [[Number.NaN]]), /invalid vector/);
  assert.throws(() => store.assertVectorsAligned(["a"], [[]]), /invalid vector/);
});
test("assertVectorsAligned passes aligned finite vectors", () => {
  assert.doesNotThrow(() => store.assertVectorsAligned(["a", "b"], [[1, 2], [3, 4]]));
});
test("partitionSaveResults separates fulfilled ids from rejections (C1)", () => {
  const { fulfilledIds, rejected } = store.partitionSaveResults([
    { status: "fulfilled", id: "a" },
    { status: "rejected", id: "b", error: "disk full" },
    { status: "fulfilled", id: "c" },
  ]);
  assert.deepEqual([...fulfilledIds].sort(), ["a", "c"]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].error, "disk full");
});

// ── D3 degraded citation ──────────────────────────────────────────────────────────
test("citationFromId returns a VISIBLY degraded citation, not a plausible fake (D3)", () => {
  const c = store.citationFromId("IMCI|p6|c1");
  assert.match(c.title, /unavailable/i);
  assert.equal(c.page, 6);
  assert.equal(c.section, "");
});

// ── citation map + D5 keyword ──────────────────────────────────────────────────────
test("loadCitationMap reads the sidecar; chunkCount reflects it", () => {
  assert.equal(store.chunkCount(), 2);
  assert.ok(store.loadCitationMap()["IMCI|p6|c1"]);
});
test("keywordSearch tags mode=keyword and scores by term coverage (D5)", () => {
  const hits = store.keywordSearch("child chest indrawing amoxicillin pneumonia", 2);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].mode, "keyword");
  assert.equal(hits[0].id, "IMCI|p6|c1", "best term-coverage chunk ranks first");
  assert.ok(hits[0].score > 0 && hits[0].score <= 1);
});

// ── D2 mtime cache ──────────────────────────────────────────────────────────────────
test("citation cache reloads when the sidecar changes on disk (D2)", () => {
  const m = JSON.parse(readFileSync(mapFile, "utf8"));
  m["IMCI|p7|c0"] = { id: "IMCI|p7|c0", content: "diarrhoea dehydration sunken eyes", protocol: "IMCI", title: "t", page: 7, section: "s" };
  writeFileSync(mapFile, JSON.stringify(m));
  utimesSync(mapFile, new Date(), new Date(Date.now() + 5000)); // force a distinct mtime
  assert.equal(store.chunkCount(), 3, "stale cache would still report 2");
});
