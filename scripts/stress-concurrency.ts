// File: scripts/stress-concurrency.ts  (Stress S2 — concurrency)
// Standalone stress harness. Boots its OWN server on an ephemeral port (port 0 -> no pre-warm, no
// collision with a running app or the test suite) and fires N concurrent /triage requests interleaved
// with /tts. The @qvac engine is single-job per process; the server serializes everything through one
// inference queue. This proves that under concurrency the queue holds: every /triage still streams a
// card, NONE surfaces the raw "Cannot set new job" engine error, identical cases yield identical
// severity (determinism under contention), and RSS does not balloon.
//
// Run (standalone, NOT part of `npm test`):
//   node --expose-gc --import tsx scripts/stress-concurrency.ts
// Requires `npm run ingest` first (loads MedPsy + GTE). Exits non-zero on any assertion failure.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-stress-conc-"));

const { app } = await import("../src/server.js");
const { orchestrator } = await import("../src/qvac/orchestrator.js");
const { chunkCount } = await import("../src/rag/store.js");

const N = 5; // concurrent /triage requests
const CASE = "2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs.";
const SPEAK = "Give oral amoxicillin for five days and follow up in three days.";

const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const gc = () => { const g = (globalThis as { gc?: () => void }).gc; if (g) { g(); g(); } };

async function readSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
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
      const event = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (event && data) out.push({ event, data: JSON.parse(data) });
    }
  }
  return out;
}

async function main() {
  if (chunkCount() === 0) {
    console.error("SKIP stress-concurrency: store not ingested — run `npm run ingest` first.");
    process.exit(0);
  }

  const server = await new Promise<import("node:http").Server>((ready) => {
    const s = app.listen(0, () => ready(s));
  });
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`stress-concurrency: server on ${base}, firing ${N} concurrent /triage + 2 /tts`);

  gc();
  const rss0 = rssMB();

  const triage = (i: number) =>
    fetch(`${base}/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseText: CASE }),
    }).then(async (r) => ({ i, events: await readSse(r) }));

  const tts = (i: number) =>
    fetch(`${base}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: SPEAK }),
    }).then(async (r) => ({ i, status: r.status, len: (await r.arrayBuffer()).byteLength }));

  // Interleave: 5 triage + 2 tts launched together, all contending for the single inference queue.
  const triageP = Array.from({ length: N }, (_, i) => triage(i));
  const ttsP = [tts(100), tts(101)];
  const [triageRes, ttsRes] = await Promise.all([Promise.all(triageP), Promise.all(ttsP)]);

  // Assertions.
  const severities = new Set<string>();
  for (const { i, events } of triageRes) {
    const kinds = events.map((e) => e.event);
    assert.ok(kinds.includes("card"), `triage #${i} streamed a card (kinds=${kinds.join(",")})`);
    assert.ok(!kinds.includes("error"), `triage #${i} surfaced NO error event under concurrency`);
    // The engine collision string must never reach the client.
    const joined = JSON.stringify(events);
    assert.doesNotMatch(joined, /Cannot set new job/i, `triage #${i} never leaked "Cannot set new job"`);
    const card = events.find((e) => e.event === "card")!.data.card;
    severities.add(card.severity);
  }
  assert.equal(severities.size, 1, `identical cases yield IDENTICAL severity under concurrency (got ${[...severities].join(",")})`);

  for (const { i, status, len } of ttsRes) {
    assert.equal(status, 200, `tts #${i} returned 200 under concurrency`);
    assert.ok(len > 44, `tts #${i} returned real WAV audio`);
  }

  gc();
  const rss1 = rssMB();
  const growth = rss1 - rss0;
  console.log(`stress-concurrency: RSS ${rss0}MB -> ${rss1}MB (+${growth}MB); severity=${[...severities][0]}`);
  assert.ok(growth < 200, `RSS growth ${growth}MB under 200MB budget for ${N} concurrent triages`);

  server.close();
  await orchestrator.shutdown();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
  console.log("stress-concurrency: PASS");
  process.exit(0);
}

main().catch((err) => {
  console.error("stress-concurrency: FAIL\n", err);
  process.exit(1);
});
