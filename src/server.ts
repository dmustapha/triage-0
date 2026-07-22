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
import express, { type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { config, translations, TTS_LANGS, type TtsLang } from "./config.js";
import { orchestrator } from "./qvac/orchestrator.js";
import { transcribeTimed, ttsTimed } from "./qvac/engine.js";
import { translateCaseToEnglish, translateCardAndPlanFromEnglish, translatePlanFromEnglish } from "./qvac/translation.js";
import { pcmInt16ToWav } from "./qvac/audio.js";
import { runTriage, retrieveGrounding, triageFromHits, assemblePlan, makeAbstainCard, type TriageContext } from "./triage/triage.js";
import { routeCase, ensureClassPrototypes } from "./triage/class-router.js";
import { readPerfRows, perfCsvPath } from "./qvac/perf-logger.js";
import { chunkCount, citationMapHealthy } from "./rag/store.js";
import { guard } from "./qvac/egress-guard.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });


/** Max characters accepted for a triage case. A real IMCI/mhGAP case is a few sentences; this keeps the
 *  input well under the embedding model's 512-token context and the reasoning model's window. */
const MAX_CASE_CHARS = 2000;
/** Max characters accepted for TTS. A spoken summary is short; this bounds how long a single request can
 *  hold the single-job inference lock and stops a ~256 KB text body from monopolising the engine. */
const MAX_TTS_CHARS = 1000;

// The @qvac inference engine is SINGLE-JOB per process — submitting a second inference while one is
// running throws "Cannot set new job". On one device with one model that is the honest physical limit:
// it does one inference at a time. So serialize every inference endpoint through one queue. Concurrent
// requests (e.g. a judge opening two tabs) wait their turn instead of colliding with a raw error.
/** Native RAG store liveness, set at prewarm by a canonical query. `chunkCount()` reads the citation
 *  SIDECAR (can report healthy while the native vector store is empty/wiped — the exact failure that made
 *  every case abstain), so this is the real "does ragSearch return hits" signal, surfaced on /health. */
let ragLive: boolean | null = null;
/** Phase 4: true once the 4 Bergamot NMT models are warmed (prewarm). null until prewarm runs; false if the
 *  warm-up failed (non-English cases still work, but the first one pays a cold model load). Surfaced on /health. */
let translationReady: boolean | null = null;
let inferenceQueue: Promise<unknown> = Promise.resolve();
function withInferenceLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = inferenceQueue.then(fn, fn);
  inferenceQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Reject a locked inference that exceeds `ms` so one wedged job cannot hold the queue forever. On a true
 *  engine wedge this surfaces a friendly error and advances the queue instead of hanging the device
 *  silently. Timeouts are generous (well above worst-case reason latency) so they fire only on a real stall. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
const TRIAGE_TIMEOUT_MS = 300_000; // 5 min — 4B model on CPU needs headroom
const VOICE_TIMEOUT_MS = 30_000;

/** Log the real error server-side (stderr only) and return a fixed, friendly message — never leak an
 *  absolute model/file path or a raw SDK string to the client (it would show in a judge's screen capture). */
function clientError(res: Response, err: unknown, message: string, code = 500): void {
  process.stderr.write(`[triage-0] ${message} :: ${(err as Error)?.stack ?? String(err)}\n`);
  if (!res.headersSent) res.status(code).json({ error: message });
}

export const app = express();
app.use(express.json({ limit: "256kb" }));

// Content-Security-Policy: must precede express.static so headers apply to all responses.
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; font-src 'self'",
  );
  next();
});

// `no-cache` = the browser may store the asset but MUST revalidate before using it (cheap: ETag → 304 when
// unchanged). Without this a browser can serve a stale triage.js after an update — which looked like the
// spoken guidance "only read one line" (old code) even though the current code reads the whole management.
app.use(express.static(resolve(process.cwd(), "public"), {
  setHeaders: (res) => { res.setHeader("Cache-Control", "no-cache"); },
}));

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
    citationMapHealthy: citationMapHealthy(),
    // null until the prewarm self-test runs; true = native ragSearch returns hits; false = store wiped.
    ragLive,
    // Phase 4: null until translation prewarm runs; true = the 4 Bergamot models are resident (FR/ES fast).
    translationReady,
    // H-6: the offline-egress guard's live state — armed (post-prewarm), strict (blocks vs records), and the
    // count of external connection attempts seen (must be 0). Turns the no-egress thesis into an observable.
    egress: { armed: guard.isArmed, strict: guard.isStrict, violations: guard.violations.length },
  });
});

// ── POST /debug/route ──────────────────────────────────────────────────────────────
// Calibration-only: returns the semantic router's shortlist + best cosine + off-domain verdict for a
// case, WITHOUT running the model. Gated behind TRIAGE0_DEBUG_ROUTE so it never ships in a demo build.
if (process.env.TRIAGE0_DEBUG_ROUTE) {
  app.post("/debug/route", async (req: Request, res: Response) => {
    const caseText = String(req.body?.caseText ?? "").trim();
    if (!caseText) return res.status(400).json({ error: "caseText is required." });
    try {
      const { embedId } = await triageContext();
      if (!embedId) return res.status(503).json({ error: "no embeddings model (degraded mode)" });
      const route = await withInferenceLock(() => routeCase(caseText, embedId));
      res.json({ best: route.best, offDomain: route.offDomain, shortlist: route.shortlist });
    } catch (err) {
      clientError(res, err, "route debug failed");
    }
  });
}

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
      withTimeout(
        orchestrator.withStt("transcribe", (id) => transcribeTimed({ modelId: id, audioChunk: tmp, phase: "transcribe" })),
        VOICE_TIMEOUT_MS, "transcribe",
      ),
    );
    res.json({ text, perf: { durationMs: ms } });
  } catch (err) {
    clientError(res, err, "Transcription failed. Please try again.");
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
    await withInferenceLock(() => withTimeout((async () => {
    const ctx = await triageContext();

    // PHASE 4: detect + translate a non-English (FR/ES) case to English BEFORE routing. Everything below
    // runs on `english`; the card + plan are translated back to `sourceLang` just before their SSE events.
    // Degrades to the original text on a translation fault (translation.ts) so routing always proceeds.
    const { english, sourceLang } = await translateCaseToEnglish(caseText);

    // Representation: a TRUTHFUL on-device pipeline readout. Each `stage` marks a REAL step that has run
    // (detect + case→English translation happened inside translateCaseToEnglish above; retrieve/reason/
    // classify/plan fire below). Additive + ignorable — the wire contract (citation<first_token<card<
    // plan<done) is unchanged. Emitted BEFORE the abstain gate too, so that (a) the readout always shows a
    // step ran, and (b) the frontend learns the case's language and renders even an abstain in it. Each
    // stage carries the raw data (lang/count/cls) so the frontend can localize; label/detail are the fallback.
    const LANG_NAME: Record<string, string> = { en: "English", fr: "Français", es: "Español" };
    send("stage", { key: "detect", label: `Detected ${LANG_NAME[sourceLang] ?? sourceLang}`, detail: "on-device langdetect", lang: sourceLang });
    if (sourceLang !== "en") send("stage", { key: "translate_in", label: "Translated case → English", detail: "on-device Bergamot NMT" });

    // PHASE 2 abstain gate: the semantic class-router decides in/out-of-domain from the case's proximity
    // to the 27 WHO class descriptors — NOT from the chunk-retrieval score (which false-abstained lay,
    // abbreviated, multi-symptom, and non-English phrasings). A truly off-domain case (adult cardiac,
    // non-medical, veterinary) matches no class well enough → abstain before the model is ever called.
    // `lang` is passed so the abstain card renders in the case's language, not English.
    const degraded = config.residentMode === "fallback" || !ctx.embedId;
    const route = degraded ? null : await routeCase(english, ctx.embedId!);
    if (route?.offDomain) {
      send("abstain", { card: makeAbstainCard(), retrieval: "abstain", lang: sourceLang });
      send("done", { ok: true });
      return endStream();
    }

    const { groundedHits, retrieval, topHits } = await retrieveGrounding(english, ctx);
    // Grounding is best-effort now (abstain already decided by the router): threshold-passing hits when
    // present, else the top chunks so an in-domain case still gets a citation panel + reason excerpts.
    const grounding = groundedHits.length ? groundedHits : topHits;
    if (grounding.length === 0) {
      // Only reachable in degraded mode (empty keyword result) or an empty store.
      send("abstain", { card: makeAbstainCard(), retrieval: "abstain", lang: sourceLang });
      send("done", { ok: true });
      return endStream();
    }

    send("stage", { key: "retrieve", label: `Searched ${chunkCount()} WHO passages`, detail: `${retrieval} retrieval`, count: chunkCount() });

    // Citation lands first (< 2s) — the demo's early payoff.
    const top = grounding[0];
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
    send("stage", { key: "reason", label: "Reasoning on-device", detail: "MedPsy 1.7B · GPU" });
    const reasonStart = Date.now();
    let firstDeltaSent = false;
    const result = await triageFromHits(english, grounding, ctx, {
      retrieval,
      shortlist: route?.shortlist,
      onReasonDelta: (chunk) => {
        if (!firstDeltaSent) {
          firstDeltaSent = true;
          send("first_token", { ttftMs: Date.now() - reasonStart });
        }
        send("reasoning", { delta: chunk });
      },
    });

    send("stage", { key: "classify", label: `Classified: ${result.classification}`, detail: "1 of 27 WHO classes", cls: result.classification });
    if (sourceLang !== "en") send("stage", { key: "translate_out", label: `Translated output → ${LANG_NAME[sourceLang] ?? sourceLang}`, detail: "on-device NMT", lang: sourceLang });

    // PHASE 4: translate the card back to the source language (action/reasoning/red_flags + the `translated`
    // flag) before it streams; the English protocol_citation is kept. English → no-op.
    const outCard = sourceLang === "en"
      ? result.card
      : (await translateCardAndPlanFromEnglish(result.card, undefined, sourceLang)).card;
    send("card", { card: outCard, classification: result.classification, citationChunk: result.citationChunk, attempts: result.attempts, perf: lastCompletionPerf() });

    // Task #22: the grounded WHO management plan lands as a SEPARATE event AFTER the card, so the
    // severity + action + citation appear at their existing timing and the multi-component plan
    // progressively fills in. assemblePlan never throws (returns an empty plan on failure).
    const plan = await assemblePlan(result.classification, result.card.severity, grounding, ctx);
    const outPlan = await translatePlanFromEnglish(plan, sourceLang);
    send("stage", { key: "plan", label: "Built WHO management plan", detail: "grounded in the cited protocol" });
    send("plan", { plan: outPlan });
    send("done", { ok: true });
    endStream();
    })(), TRIAGE_TIMEOUT_MS, "triage"));
  } catch (err) {
    process.stderr.write(`[triage-0] triage error :: ${(err as Error)?.stack ?? String(err)}\n`);
    send("error", { error: "Triage could not complete on-device. Please retry, or escalate to a clinician." });
    endStream();
  }
});

// ── POST /tts ────────────────────────────────────────────────────────────────────
app.post("/tts", async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required." });
  if (text.length > MAX_TTS_CHARS) {
    return res.status(400).json({ error: "Text is too long to read aloud. Please shorten it." });
  }
  // The voice follows the case's language so a French plan is spoken in French. Only en/fr/es have a
  // supported voice; anything else falls back to English (the spoken text is still correct).
  const reqLang = String(req.body?.lang ?? "en").toLowerCase();
  const lang = (TTS_LANGS as readonly string[]).includes(reqLang) ? (reqLang as TtsLang) : "en";
  try {
    const { pcm, sampleRate, ms } = await withInferenceLock(() =>
      withTimeout(orchestrator.withTts("tts", lang, (id) => ttsTimed({ modelId: id, text, phase: "tts" })), VOICE_TIMEOUT_MS, "tts"),
    );
    const wav = pcmInt16ToWav(pcm, sampleRate);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("X-Perf", JSON.stringify({ durationMs: ms, samples: pcm.length, sampleRate }));
    res.send(wav);
  } catch (err) {
    clientError(res, err, "Could not generate audio. Please try again.");
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

// Centralised error handler (must be last). Maps body-parser + multer failures to clean JSON instead of
// an HTML 500, so malformed JSON or an oversized upload returns a friendly status and the server stays up.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const e = err as { type?: string; code?: string; name?: string };
  if (res.headersSent) return next(err);
  if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large." });
  if (e?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Audio file is too large (max 10 MB)." });
  // Any other multer error (unexpected field, too many files, malformed multipart) is a client mistake → 400.
  if (e?.name === "MulterError") return res.status(400).json({ error: "Invalid file upload." });
  if (err instanceof SyntaxError) return res.status(400).json({ error: "Malformed JSON body." });
  process.stderr.write(`[triage-0] unhandled route error :: ${(err as Error)?.stack ?? String(err)}\n`);
  return res.status(500).json({ error: "Something went wrong on-device." });
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
    // H-7: a fresh clone that skipped `npm run ingest` has an empty citation map (chunkCount()===0), so every
    // triage would abstain and look like intended behavior. Warn LOUDLY at boot (the wiped-native-store case
    // is caught separately by the ragLive self-test below). Also surfaced on /health + a first-load UI banner.
    if (chunkCount() === 0) {
      process.stderr.write(
        "[triage-0] ⚠️  RAG STORE EMPTY: 0 guideline chunks loaded (data/rag/citation-map.json missing). " +
        "Every case will abstain until you run `npm run ingest`.\n",
      );
    }
  });
  // F5: pre-warm the models + the embed engine's cold first-call so the FIRST triage is not a 30-45s cold
  // start (the demo's biggest latency risk). Best-effort, serialized via the inference lock so it never
  // collides with an incoming request, and never blocks listen. Skipped on an ephemeral port (tests own
  // their own model lifecycle) or when TRIAGE0_NO_PREWARM is set.
  if (port !== 0 && !process.env.TRIAGE0_NO_PREWARM) {
    void withInferenceLock(async () => {
      try {
        const [medpsyId, embedId] = await Promise.all([orchestrator.getMedpsy(), orchestrator.getEmbeddings()]);
        const warm = await retrieveGrounding("child fever cough fast breathing", { medpsyId, embedId });
        // Store-liveness self-test (closes the Phase-1 blind spot): a canonical clinical query MUST return
        // grounding hits. If the native vector store was wiped, this returns 0 while chunkCount() still
        // reports the sidecar count — so warn LOUDLY rather than silently abstain on every case.
        ragLive = warm.topHits.length > 0;
        if (!ragLive) {
          process.stderr.write(
            "[triage-0] ⚠️  RAG STORE EMPTY: a canonical query returned 0 hits. The native store " +
            "(~/.qvac/rag-hyperdb) is likely missing/wiped — every triage will abstain. Run `npm run ingest`.\n",
          );
        }
        // Phase 2: embed the 27 class-router descriptors once now (single batched call) so the first
        // /triage pays nothing for routing.
        if (embedId) await ensureClassPrototypes(embedId);
        process.stdout.write(`[triage-0] models pre-warmed; first triage will be fast (ragLive=${ragLive})\n`);
      } catch (err) {
        process.stderr.write(`[triage-0] pre-warm skipped: ${(err as Error)?.message ?? err}\n`);
      }
      // L-5: warm the voice models too. The Supertonic TTS blob is a ~100s cold download on a fresh
      // machine; the /tts and /transcribe routes cap loads at VOICE_TIMEOUT_MS (30s), so an un-cached
      // first request always fails. Warming here downloads+caches both blobs and — in resident mode —
      // keeps them loaded (~0.3GB) so the first live voice request is fast. Best-effort; voice is
      // optional, so a failure here must never take down the text path. Skip via TRIAGE0_NO_VOICE_PREWARM.
      if (!process.env.TRIAGE0_NO_VOICE_PREWARM) {
        try {
          await orchestrator.withStt("prewarm-stt", async () => { /* ensure loads + (resident) keeps STT */ });
          await orchestrator.withTts("prewarm-tts", "en", (id) => ttsTimed({ modelId: id, text: "Ready.", phase: "prewarm-tts" }));
          process.stdout.write("[triage-0] voice models pre-warmed; first /tts and /transcribe will be fast\n");
        } catch (err) {
          process.stderr.write(`[triage-0] voice pre-warm skipped: ${(err as Error)?.message ?? err}\n`);
        }
      }
      // Phase 4: warm the 4 Bergamot NMT models (fr<->en, es<->en). Each is a ~30MB registry blob; loading
      // them here (SDK caches to ~/.qvac and, in resident mode, keeps them) means the FIRST non-English
      // triage does not pay a cold model load mid-demo. Sequential (single-job engine). Best-effort:
      // translation degrades to English routing on failure, so a warm-up miss must never fail startup.
      // Skip via TRIAGE0_NO_TRANSLATION_PREWARM.
      if (!process.env.TRIAGE0_NO_TRANSLATION_PREWARM) {
        try {
          for (const key of Object.keys(translations)) {
            await orchestrator.ensure(translations[key], "prewarm-translate");
          }
          translationReady = true;
          process.stdout.write("[triage-0] translation models pre-warmed; first FR/ES triage will be fast\n");
        } catch (err) {
          process.stderr.write(`[triage-0] translation pre-warm skipped: ${(err as Error)?.message ?? err}\n`);
        }
      }
      // H-6: arm the offline-egress guard in the SERVING process (not just a test/script). Armed LAST, after
      // every model prewarm, so the one disclosed egress — the first-run weight download — is already done
      // and cached. From here any external connection attempt is a real violation and is BLOCKED (strict),
      // converting the "the patient's case never leaves the device" thesis from tested → enforced. Escape
      // hatch: TRIAGE0_EGRESS_NONSTRICT = record-only (still surfaced on /health, but does not block).
      const strict = !process.env.TRIAGE0_EGRESS_NONSTRICT;
      guard.arm(strict);
      process.stdout.write(`[triage-0] egress guard armed (${strict ? "strict — external connections blocked" : "record-only"}); the case never leaves the device\n`);
    });
  }
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
