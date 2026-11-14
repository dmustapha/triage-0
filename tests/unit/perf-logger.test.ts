// Unit tests for the scored perf-log artifact. Redirect output to a temp dir via TRIAGE0_PERF_DIR
// so we never touch the repo's real logs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "triage0-perf-"));
  process.env.TRIAGE0_PERF_DIR = dir;
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("logPerf appends to CSV (with header) and JSONL; readPerfRows round-trips", async () => {
  const { logPerf, readPerfRows, perfCsvPath, perfJsonlPath } = await import("../../src/qvac/perf-logger.js");
  for (let i = 0; i < 3; i++) {
    logPerf({ ts: `2026-06-19T00:00:0${i}Z`, phase: "test", event: "embed", modelId: "m", durationMs: i, ttftMs: i * 10 });
  }
  const rows = readPerfRows();
  assert.equal(rows.length, 3, "three rows read back from JSONL");
  assert.equal(rows[2].durationMs, 2);
  assert.equal(rows[1].ttftMs, 10);

  const csv = readFileSync(perfCsvPath(), "utf8");
  assert.ok(csv.startsWith("ts,phase,event,modelId"), "CSV has the header row");
  assert.equal(csv.trim().split("\n").length, 4, "header + 3 rows");

  // JSONL is one valid JSON object per line.
  const jsonl = readFileSync(perfJsonlPath(), "utf8").trim().split("\n");
  assert.equal(jsonl.length, 3);
  for (const line of jsonl) assert.doesNotThrow(() => JSON.parse(line));
});

test("snapshotPerfJson renders a JSON array matching the JSONL rows", async () => {
  const { snapshotPerfJson, readPerfRows } = await import("../../src/qvac/perf-logger.js");
  const p = snapshotPerfJson();
  assert.ok(existsSync(p));
  const arr = JSON.parse(readFileSync(p, "utf8"));
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, readPerfRows().length);
});

test("readPerfRows tolerates a corrupt line without throwing", async () => {
  const { perfJsonlPath, readPerfRows } = await import("../../src/qvac/perf-logger.js");
  const { appendFileSync } = await import("node:fs");
  const before = readPerfRows().length;
  appendFileSync(perfJsonlPath(), "{ this is not json\n", "utf8");
  const after = readPerfRows();
  assert.equal(after.length, before, "the corrupt line is skipped, valid rows survive");
});
