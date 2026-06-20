// File: src/server.ts
// Triage-0 local server. Hosts @qvac/sdk and serves the localhost web UI. Every clinical call runs
// on-device through the orchestrator (model lifecycle) + engine (timed, perf-logged). This process is
// the SOLE opener of the RAG store (single-writer RocksDB) — do not run it alongside `npm run ingest`.
//
// Routes:
//   GET  /health        — liveness + resident models + chunk count + resident mode
//   POST /transcribe    — multipart "audio" -> { text, perf }            (whisper, via temp file)
//   POST /triage        — SSE: citation (early) -> reasoning deltas -> card+perf   (E-5 cinematic)
//   POST /tts           — { text } -> audio/wav                          (supertonic)
//   GET  /perf-log      — { rows }   |   GET /perf-log.csv — raw CSV
import express, { type Request, type Response } from "express";
import multer from "multer";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { orchestrator } from "./qvac/orchestrator.js";
import { transcribeTimed, ttsTimed } from "./qvac/engine.js";
import { pcmInt16ToWav } from "./qvac/audio.js";
import { runTriage, retrieveGrounding, triageFromHits, assemblePlan, makeAbstainCard, type TriageContext } from "./triage/triage.js";
import { readPerfRows, perfCsvPath } from "./qvac/perf-logger.js";
import { chunkCount } from "./rag/store.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Max characters accepted for a triage case. A real IMCI/mhGAP case is a few sentences; this keeps the
 *  input well under the embedding model's 512-token context and the reasoning model's window. */
const MAX_CASE_CHARS = 2000;

// The @qvac inference engine is SINGLE-JOB per process — submitting a second inference while one is
// running throws "Cannot set new job". On one device with one model that is the honest physical limit:
// it does one inference at a time. So serialize every inference endpoint through one queue. Concurrent
// requests (e.g. a judge opening two tabs) wait their turn instead of colliding with a raw error.
let inferenceQueue: Promise<unknown> = Promise.resolve();
function withInferenceLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = inferenceQueue.then(fn, fn);
  inferenceQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(resolve(process.cwd(), "public")));

// Clean URL for the tool. The landing is "/" (public/index.html, served by static above); the tool
// lives at public/app.html and is reachable at "/app.html" via static, but the landing CTA links to
// "/app", so alias it. (A future "/proof" page would get the same treatment once it exists.)
app.get("/app", (_req: Request, res: Response) => {
  res.sendFile(resolve(process.cwd(), "public", "app.html"));
});

/** The latest completion perf row (TTFT/tps/device) for the HUD. */
function lastCompletionPerf() {
  const r = readPerfRows().filter((row) => row.event === "completion").at(-1);
  return {
    ttftMs: r?.ttftMs ?? null,
    tokensPerSec: r?.tokensPerSec ?? null,
    totalTokens: r?.totalTokens ?? null,
    backendDevice: r?.backendDevice ?? null,
  };
}

/** Reasoning model ids for triage — loaded once, kept resident by the orchestrator. */
async function triageContext(): Promise<TriageContext> {
  const [medpsyId, embedId] = await Promise.all([orchestrator.getMedpsy(), orchestrator.getEmbeddings()]);
  return { medpsyId, embedId };
}

// ── GET /health ──────────────────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    residentModels: orchestrator.residentRoles(),
    residentMode: config.residentMode,
    medpsy: config.modelId,
    chunks: chunkCount(),
  });
});

// ── POST /transcribe ───────────────────────────────────────────────────────────────
app.post("/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "No audio uploaded (field 'audio')." });
  // The SDK decodes any container/sample-rate via FFmpeg, but takes a path or buffer — write a temp
  // file (proven path input) and clean it up. Never resample here.
  const tmpDir = mkdtempSync(join(tmpdir(), "triage0-stt-"));
  const tmp = join(tmpDir, `${randomUUID()}.bin`);
  try {
    writeFileSync(tmp, req.file.buffer);
    const { text, ms } = await withInferenceLock(() =>
      orchestrator.withStt("transcribe", (id) => transcribeTimed({ modelId: id, audioChunk: tmp, phase: "transcribe" })),
    );
    res.json({ text, perf: { durationMs: ms } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    // Remove the whole temp DIR, not just the file — otherwise a dir leaks per request.
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── POST /triage (Server-Sent Events) ───────────────────────────────────────────────
// E-5: emit the matched WHO citation FIRST (sub-2s, from retrieval), then stream reasoning deltas,
// then the final card + perf. The whole wow lands early; the reasoning wait is visible, not dead air.
app.post("/triage", async (req: Request, res: Response) => {
  const caseText = String(req.body?.caseText ?? "").trim();
  if (!caseText) return res.status(400).json({ error: "caseText is required." });
  // The embedding model has a 512-token context; a real clinical case is a few sentences. Reject an
  // oversized payload with a friendly message instead of letting it overflow the embedder mid-stream.
  if (caseText.length > MAX_CASE_CHARS) {
    return res.status(400).json({ error: "Case description is too long. Please shorten it to the key signs and symptoms." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  // The judge may close the tab during the ~20s reasoning wait. Guard every write: once the socket is
  // gone, send() becomes a no-op instead of throwing on a destroyed stream (which would otherwise
  // bubble out of the model drain loop as an unhandled rejection and crash the server).
  // NOTE: listen on RES, not REQ — for a POST whose JSON body express already consumed, the request
  // stream emits "close" the moment the body is fully read (mid-response), which would falsely mark the
  // stream closed and hang it forever. The response "close" fires only on real completion or a genuine
  // client disconnect.
  let closed = false;
  res.on("close", () => { closed = true; });
  const send = (event: string, data: unknown) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      closed = true;
    }
  };
  const endStream = () => { if (!closed && !res.writableEnded) res.end(); };

  try {
    // Serialize the whole inference sequence: the engine is single-job, so two concurrent /triage
    // requests must queue, not interleave (else one gets "Cannot set new job"). The stream stays open
    // and silent while waiting its turn, then runs normally.
    await withInferenceLock(async () => {
    const ctx = await triageContext();
    const { groundedHits, retrieval } = await retrieveGrounding(caseText, ctx);

    if (groundedHits.length === 0) {
      // Abstain before the model is ever called.
      send("abstain", { card: makeAbstainCard(), retrieval: "abstain" });
      send("done", { ok: true });
      return endStream();
    }

    // Citation lands first (< 2s) — the demo's early payoff.
    const top = groundedHits[0];
    send("citation", {
      protocol: top.protocol,
      doc: top.citation.title,
      page: top.citation.page,
      section: (top.citation.section || top.text.slice(0, 200)).replace(/\s+/g, " ").trim(),
      score: Number(top.score.toFixed(3)),
      retrieval,
    });

    // Stream reasoning tokens as the model thinks (strip <think> tags client-side is unnecessary —
    // the deltas already include them; we surface a "reasoning…" affordance in the UI).
    const reasonStart = Date.now();
    let firstDeltaSent = false;
    const result = await triageFromHits(caseText, groundedHits, ctx, {
      retrieval,
      onReasonDelta: (chunk) => {
        if (!firstDeltaSent) {
          firstDeltaSent = true;
          send("first_token", { ttftMs: Date.now() - reasonStart });
        }
        send("reasoning", { delta: chunk });
      },
    });

    send("card", { card: result.card, citationChunk: result.citationChunk, attempts: result.attempts, perf: lastCompletionPerf() });

    // Task #22: the grounded WHO management plan lands as a SEPARATE event AFTER the card, so the
    // severity + action + citation appear at their existing timing and the multi-component plan
    // progressively fills in. assemblePlan never throws (returns an empty plan on failure).
    const plan = await assemblePlan(result.classification, result.card.severity, groundedHits, ctx);
    send("plan", { plan });
    send("done", { ok: true });
    endStream();
    });
  } catch (err) {
    send("error", { error: (err as Error).message });
    endStream();
  }
});

// ── POST /tts ────────────────────────────────────────────────────────────────────
app.post("/tts", async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required." });
  try {
    const { pcm, sampleRate, ms } = await withInferenceLock(() =>
      orchestrator.withTts("tts", (id) => ttsTimed({ modelId: id, text, phase: "tts" })),
    );
    const wav = pcmInt16ToWav(pcm, sampleRate);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Perf", JSON.stringify({ durationMs: ms, samples: pcm.length, sampleRate }));
    res.send(wav);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /perf-log + /perf-log.csv ──────────────────────────────────────────────────
app.get("/perf-log", (_req: Request, res: Response) => {
  res.json({ rows: readPerfRows() });
});
app.get("/perf-log.csv", (_req: Request, res: Response) => {
  const p = perfCsvPath();
  if (!existsSync(p)) return res.status(404).send("no perf log yet");
  res.setHeader("Content-Type", "text/csv");
  res.send(readFileSync(p, "utf8"));
});

/** Start listening. Returns the http.Server so tests can use an ephemeral port + close cleanly. */
export function startServer(port = config.port) {
  // Last-line defence: a stray async rejection (e.g. a write to a socket that died at the wrong tick)
  // must never take the whole server down mid-demo. Log and keep serving.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[triage-0] unhandledRejection (ignored, server stays up): ${String(reason)}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[triage-0] uncaughtException (ignored, server stays up): ${err?.stack ?? err}\n`);
  });
  const server = app.listen(port, () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    process.stdout.write(`Triage-0 listening on http://localhost:${p}  (MedPsy ${config.modelId}, mode=${config.residentMode})\n`);
  });
  return server;
}

// Run directly (`npm start`) but not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]).endsWith("server.ts")) {
  const server = startServer();
  const shutdown = async () => {
    try {
      server.close();
      await orchestrator.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// runTriage is re-exported for callers/tests that want the non-streaming path.
export { runTriage };
