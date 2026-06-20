// File: tests/integration/server.test.ts
// Phase-4 P1 milestone gate: the whole hero loop through the HTTP server, end-to-end on the live SDK.
// Boots the Express app on an ephemeral port and exercises /health, /triage (SSE: citation lands
// first, then a grounded card), and /tts (audio/wav). This is the offline "speak->cited triage->speak"
// path that IS the submission's core claim, proven by an automated test rather than only by hand.
//
// Loads MedPsy + GTE + supertonic. SLOW. Self-skips if the store isn't ingested or models aren't cached.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));

const { app } = await import("../../src/server.js");
const { orchestrator } = await import("../../src/qvac/orchestrator.js");
const { chunkCount } = await import("../../src/rag/store.js");

const cacheDir = join(homedir(), ".qvac", "models");
const ttsCached = existsSync(cacheDir) && readdirSync(cacheDir).some((f) => /supertonic/i.test(f));
const skip = chunkCount() > 0 && ttsCached ? false : "store not ingested or TTS model not cached";

let server: { address(): { port: number } | string | null; close(): void };
let base = "";
before(async () => {
  if (skip) return;
  await new Promise<void>((resolveReady) => {
    server = app.listen(0, () => resolveReady()) as never;
  });
  const addr = (server as { address(): { port: number } }).address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(async () => {
  if (server) server.close();
  await orchestrator.shutdown();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

/** Read an SSE response body into a list of {event, data} objects. */
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

test("GET /health reports ok + ingested chunks", { skip, timeout: 60_000 }, async () => {
  const r = await fetch(`${base}/health`);
  const h = await r.json();
  assert.equal(h.ok, true);
  assert.ok(h.chunks > 0, "store has chunks");
  assert.equal(h.medpsy, "1.7b");
});

test("POST /triage streams citation-first then a grounded, non-EMERGENCY card for pneumonia", { skip, timeout: 300_000 }, async () => {
  const r = await fetch(`${base}/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseText: "2-year-old, cough 3 days, chest indrawing, breathing 52 a minute, alert and drinking, no danger signs." }),
  });
  assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
  const events = await readSse(r);
  const kinds = events.map((e) => e.event);

  // Citation must arrive BEFORE the card (E-5 sequencing).
  const ci = kinds.indexOf("citation");
  const cardi = kinds.indexOf("card");
  assert.ok(ci >= 0, "got a citation event");
  assert.ok(cardi > ci, "card event arrives after citation");

  const citation = events[ci].data;
  assert.match(citation.doc, /IMCI/i, "cited the IMCI protocol");
  assert.ok(String(citation.page).match(/\d/), "citation has a real page");

  const card = events[cardi].data.card;
  assert.notEqual(card.severity, "EMERGENCY", `home-treatment pneumonia must not be EMERGENCY (got ${card.severity})`);
  assert.ok(["URGENT", "ROUTINE"].includes(card.severity));
  assert.ok(events[cardi].data.perf, "card carries a perf payload for the HUD");

  // #22: the grounded management plan arrives as a SEPARATE event AFTER the card (progressive enhancement).
  const pi = kinds.indexOf("plan");
  assert.ok(pi > cardi, "plan event arrives after the card");
  const plan = events[pi].data.plan;
  assert.ok(plan.medicines.length >= 1, "plan surfaces at least one medicine for PNEUMONIA");
  assert.match(plan.medicines.map((m: any) => m.name).join(" ").toLowerCase(), /amoxicillin/);
  for (const m of plan.medicines) {
    assert.ok(m.citation && String(m.citation.page).match(/\d/), "each medicine carries a real page citation");
    if (m.dose) assert.equal(m.dose, "By weight band", "dose is banded guidance, never a fabricated amount");
  }
});

test("POST /triage rejects an oversized case with a friendly 400 (no embedder overflow)", { skip, timeout: 30_000 }, async () => {
  const r = await fetch(`${base}/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caseText: "a".repeat(5000) }),
  });
  assert.equal(r.status, 400, "oversized case is rejected before it can overflow the embedding context");
  const j = await r.json();
  assert.match(j.error, /too long/i);
});

test("POST /tts returns a playable WAV", { skip, timeout: 120_000 }, async () => {
  const r = await fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Give oral amoxicillin for five days and follow up in three days." }),
  });
  assert.equal(r.headers.get("content-type"), "audio/wav");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 44, "WAV has audio data beyond the header");
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
});
