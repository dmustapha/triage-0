// File: tests/unit/perf-csv.test.ts
// MODEL-FREE. Extends perf-logger coverage to the CSV artifact's STRUCTURE: the perf log is a scored
// submission artifact, so the header column order must be exact + stable, and a field containing a comma,
// a quote, or a newline must be RFC-4180 escaped so the CSV stays parseable (a corrupted cell would
// silently shift every column in the auditor's spreadsheet).
//
// csvCell/rowToCsv/HEADER are module-private, so we exercise them through the public logPerf -> file path
// and assert on the bytes written, plus an independent RFC-4180 parse that round-trips the awkward field.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "triage0-perfcsv-"));
  process.env.TRIAGE0_PERF_DIR = dir;
});
after(() => rmSync(dir, { recursive: true, force: true }));

const EXPECTED_HEADER =
  "ts,phase,event,modelId,promptTokens,ttftMs,tokensPerSec,totalTokens,backendDevice,durationMs";

/** Minimal RFC-4180 CSV row parser (handles quoted fields with embedded , " and \n). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test("CSV header column order is exact and stable", async () => {
  const { logPerf, perfCsvPath } = await import("../../src/qvac/perf-logger.js");
  logPerf({ ts: "2026-06-21T00:00:00Z", phase: "test", event: "embed", modelId: "m", durationMs: 1 });
  const csv = readFileSync(perfCsvPath(), "utf8");
  const firstLine = csv.split("\n")[0];
  assert.equal(firstLine, EXPECTED_HEADER, "header columns are in the exact documented order");
});

test("csvCell escapes commas, quotes, and newlines; a comma-bearing field round-trips", async () => {
  const { logPerf, perfCsvPath } = await import("../../src/qvac/perf-logger.js");
  // A modelId carrying every awkward CSV character at once.
  const nasty = 'gpu, "metal"\nbackend';
  logPerf({ ts: "2026-06-21T00:00:01Z", phase: "test", event: "completion", modelId: nasty, durationMs: 2 });

  const csv = readFileSync(perfCsvPath(), "utf8");
  // The raw bytes must wrap the field in quotes and double its inner quotes.
  assert.match(csv, /"gpu, ""metal""\nbackend"/, "comma/quote/newline field is RFC-4180 escaped");

  // And it must round-trip back to the EXACT original value through a real CSV parse.
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], EXPECTED_HEADER.split(","), "header parses to the column list");
  const match = rows.find((r) => r[0] === "2026-06-21T00:00:01Z");
  assert.ok(match, "the escaped row is found by its ts");
  assert.equal(match![3], nasty, "modelId field survives comma + quote + newline intact");
  assert.equal(match!.length, 10, "the embedded comma did NOT split into an extra column");
});

test("undefined / null optional fields render as empty cells (not the string 'undefined')", async () => {
  const { logPerf, perfCsvPath } = await import("../../src/qvac/perf-logger.js");
  // promptTokens/ttftMs/tokensPerSec/totalTokens/backendDevice all omitted -> empty cells.
  logPerf({ ts: "2026-06-21T00:00:02Z", phase: "test", event: "search", modelId: "plain", durationMs: 3 });
  const csv = readFileSync(perfCsvPath(), "utf8");
  const rows = parseCsv(csv);
  const row = rows.find((r) => r[0] === "2026-06-21T00:00:02Z")!;
  assert.equal(row[4], "", "promptTokens empty");
  assert.equal(row[5], "", "ttftMs empty");
  assert.equal(row[8], "", "backendDevice empty");
  assert.doesNotMatch(csv, /undefined|null/, "no literal 'undefined'/'null' leaks into the CSV");
});
