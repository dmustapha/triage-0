// File: scripts/stress-soak.ts  (Stress S7 — soak / leak)
// Standalone soak harness. Boots its OWN server on an ephemeral port and runs 50 sequential /triage
// requests, cycling 3 seed cases. Proves the single-job inference queue never WEDGES over a long run
// (every request still completes with a card), memory does not leak (RSS slope < 1 MB/request after a
// warm-up window), and the two perf artifacts stay consistent: the CSV has exactly one more line than the
// JSONL (its header), and that header is byte-identical to the documented column order.
//
// Run (standalone, NOT part of `npm test`):
//   node --expose-gc --import tsx scripts/stress-soak.ts
// Requires `npm run ingest` first. Uses a TEMP TRIAGE0_PERF_DIR so the repo's real logs are untouched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-stress-soak-"));
process.env.TRIAGE0_PERF_DIR = PERF_DIR;

const { app } = await import("../src/server.js");
const { orchestrator } = await import("../src/qvac/orchestrator.js");
const { chunkCount } = await import("../src/rag/store.js");
const { perfCsvPath, perfJsonlPath } = await import("../src/qvac/perf-logger.js");

const RUNS = 50;
const EXPECTED_HEADER =
  "ts,phase,event,modelId,promptTokens,ttftMs,tokensPerSec,totalTokens,backendDevice,durationMs";
const SEEDS = [
  "2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs.",
  "Eleven month old with cough, now lethargic and unable to drink, breathing 60 a minute with stridor while calm.",
  "Adult with low mood, loss of interest, poor sleep and appetite for the past three weeks.",
];

const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const gc = () => { const g = (globalThis as { gc?: () => void }).gc; if (g) { g(); g(); } };

async function readSse(res: Response): Promise<string[]> {
  const kinds: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = (block.match(/^event: (.*)$/m) || [])[1];
      if (ev) kinds.push(ev);
    }
  }
  return kinds;
}

async function main() {
  if (chunkCount() === 0) {
    console.error("SKIP stress-soak: store not ingested — run `npm run ingest` first.");
    process.exit(0);
  }

  const server = await new Promise<import("node:http").Server>((ready) => {
    const s = app.listen(0, () => ready(s));
  });
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`stress-soak: server on ${base}, ${RUNS} sequential /triage`);

  const rssSamples: number[] = [];
  for (let n = 0; n < RUNS; n++) {
    const caseText = SEEDS[n % SEEDS.length];
    const r = await fetch(`${base}/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseText }),
    });
    const kinds = await readSse(r);
    // The queue must never wedge: every run produces a terminal frame (card or abstain) then done.
    assert.ok(
      kinds.includes("card") || kinds.includes("abstain"),
      `run ${n}: produced a terminal card/abstain (queue not wedged; kinds=${kinds.join(",")})`,
    );
    assert.ok(kinds[kinds.length - 1] === "done", `run ${n}: stream ended with done`);
    assert.ok(!kinds.includes("error"), `run ${n}: no error event`);
    if (n % 5 === 0) { gc(); rssSamples.push(rssMB()); }
  }

  // RSS slope across the run (post warm-up). Fit a simple slope over the sampled RSS vs request index.
  gc();
  rssSamples.push(rssMB());
  // Discard the first sample (model warm-up) before estimating the per-request slope.
  const warm = rssSamples.slice(1);
  const first = warm[0];
  const last = warm[warm.length - 1];
  const slopePerReq = (last - first) / RUNS;
  console.log(`stress-soak: RSS samples ${rssSamples.join(",")}MB; slope ${slopePerReq.toFixed(3)} MB/req`);
  assert.ok(slopePerReq < 1, `RSS slope ${slopePerReq.toFixed(3)} MB/req under 1 MB/req (no leak)`);

  // Perf artifact consistency: CSV lines === JSONL lines + 1 (the header), header byte-identical.
  const csv = readFileSync(perfCsvPath(), "utf8");
  const jsonl = readFileSync(perfJsonlPath(), "utf8");
  const csvLines = csv.split("\n").filter(Boolean);
  const jsonlLines = jsonl.split("\n").filter(Boolean);
  assert.equal(csvLines[0], EXPECTED_HEADER, "CSV header is byte-identical to the documented column order");
  assert.equal(
    csvLines.length,
    jsonlLines.length + 1,
    `CSV has exactly one more line than JSONL (the header): csv=${csvLines.length} jsonl=${jsonlLines.length}`,
  );

  server.close();
  await orchestrator.shutdown();
  rmSync(PERF_DIR, { recursive: true, force: true });
  console.log("stress-soak: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("stress-soak: FAIL\n", err);
  process.exit(1);
});
