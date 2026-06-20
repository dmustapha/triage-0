// File: src/qvac/engine.ts
// The single timed gateway to @qvac/sdk (via sdk.ts). Every call times with performance.now(),
// pulls native stats from final.stats, and writes one perf-log row. RECONCILED against the
// Phase-0 event shape: contentDelta events carry text on `ev.text`; final answer is `final.contentText`.
import { performance } from "node:perf_hooks";
import {
  ChatMessage,
  completion,
  embed,
  embedBatch,
  loadModel,
  QvacStats,
  ragChunk,
  textToSpeech,
  transcribe,
  unloadModel,
} from "./sdk.js";
import { logPerf } from "./perf-logger.js";
import { toInt16 } from "./audio.js";
import { TTS_SAMPLE_RATE, type ModelSpec } from "../config.js";

export interface CompletionResult {
  text: string;
  toolCalls: unknown[];
  stats: QvacStats;
}

const ZERO_STATS: QvacStats = {
  timeToFirstToken: 0, tokensPerSecond: 0, totalTokens: 0, backendDevice: "unknown",
};

/** Approx token count for the perf log when the SDK does not report prompt tokens. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function loadModelTimed(
  spec: ModelSpec,
  phase: string,
): Promise<{ modelId: string; loadMs: number }> {
  const t0 = performance.now();
  const modelId = await loadModel({
    modelSrc: spec.modelSrc,
    modelType: spec.modelType,
    // tts carries an explicit modelConfig (required); llm/embeddings use ctx_size; whisper none.
    modelConfig: spec.modelConfig ?? (spec.ctxSize ? { ctx_size: spec.ctxSize } : undefined),
  });
  const loadMs = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase, event: "load", modelId: `${spec.role}:${modelId}`,
    durationMs: Math.round(loadMs),
  });
  return { modelId, loadMs };
}

export async function unloadModelTimed(
  modelId: string,
  role: string,
  phase: string,
): Promise<{ unloadMs: number }> {
  const t0 = performance.now();
  await unloadModel(modelId);
  const unloadMs = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase, event: "unload", modelId: `${role}:${modelId}`,
    durationMs: Math.round(unloadMs),
  });
  return { unloadMs };
}

/**
 * Streaming completion. Drains `run.events` (contentDelta -> ev.text), awaits `run.final`
 * for native stats (final.contentText), logs one perf row, optionally forwards deltas.
 */
export async function completionTimed(args: {
  modelId: string;
  history: ChatMessage[];
  phase: string;
  tools?: unknown[];
  /** Token cap goes here as `predict` — there is NO top-level maxTokens (RECONCILE.md Phase-2 / DEV-007). */
  generationParams?: { predict?: number; temp?: number; reasoning_budget?: -1 | 0; [k: string]: unknown };
  responseFormat?: unknown;
  onDelta?: (chunk: string) => void;
}): Promise<CompletionResult> {
  const t0 = performance.now();
  const run = completion({
    modelId: args.modelId,
    history: args.history,
    stream: true,
    tools: args.tools,
    generationParams: args.generationParams,
    responseFormat: args.responseFormat,
  });

  let text = "";
  for await (const ev of run.events) {
    const delta =
      (ev.type === "contentDelta" ? ev.text : undefined) ??
      ev.contentDelta ?? ev.content ?? ev.delta ?? "";
    if (delta) {
      text += delta;
      args.onDelta?.(delta);
    }
  }
  const final = await run.final;
  const durationMs = performance.now() - t0;
  const stats: QvacStats = final.stats ?? ZERO_STATS;
  const finalText = final.contentText ?? final.text ?? final.content ?? text;
  const toolCalls = (final.toolCalls ?? final.tool_calls ?? []) as unknown[];

  logPerf({
    ts: new Date().toISOString(),
    phase: args.phase, event: "completion", modelId: args.modelId,
    // Prefer the addon's real prompt-token count; fall back to a char/4 estimate (DEV-007).
    promptTokens: stats.promptTokens ?? approxTokens(args.history.map((m) => m.content).join(" ")),
    ttftMs: Math.round(stats.timeToFirstToken),
    tokensPerSec: Number(stats.tokensPerSecond?.toFixed?.(2) ?? stats.tokensPerSecond),
    // Native field is `generatedTokens`; `totalTokens` was always undefined at runtime (DEV-007).
    totalTokens: stats.generatedTokens ?? stats.totalTokens,
    backendDevice: stats.backendDevice,
    durationMs: Math.round(durationMs),
  });

  return { text: finalText, toolCalls, stats };
}

/** STT. `audioChunk` is a file PATH or audio bytes; the SDK decodes any sample rate via FFmpeg. */
export async function transcribeTimed(args: {
  modelId: string;
  audioChunk: string | Buffer | Uint8Array;
  phase: string;
}): Promise<{ text: string; ms: number }> {
  const t0 = performance.now();
  const { text } = await transcribe({ modelId: args.modelId, audioChunk: args.audioChunk });
  const ms = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase: args.phase, event: "transcribe", modelId: args.modelId,
    durationMs: Math.round(ms),
  });
  return { text: text.trim(), ms: Math.round(ms) };
}

export async function embedTimed(args: {
  modelId: string;
  text: string;
  phase: string;
}): Promise<{ vector: number[]; ms: number }> {
  const t0 = performance.now();
  const vector = await embed({ modelId: args.modelId, text: args.text });
  const ms = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase: args.phase, event: "embed", modelId: args.modelId,
    durationMs: Math.round(ms),
  });
  return { vector, ms: Math.round(ms) };
}

/** Batch embed N texts in one SDK call (ingest efficiency). One perf row for the batch. */
export async function embedBatchTimed(args: {
  modelId: string;
  texts: string[];
  phase: string;
}): Promise<{ vectors: number[][]; ms: number }> {
  const t0 = performance.now();
  const vectors = await embedBatch({ modelId: args.modelId, text: args.texts });
  const ms = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase: args.phase, event: "embed", modelId: args.modelId,
    totalTokens: args.texts.length, durationMs: Math.round(ms),
  });
  return { vectors, ms: Math.round(ms) };
}

/** TTS. Drains the SDK stream to int16 PCM (RECONCILE.md Phase-3) and returns it + the sample rate. */
export async function ttsTimed(args: {
  modelId: string;
  text: string;
  phase: string;
}): Promise<{ pcm: Int16Array; sampleRate: number; ms: number }> {
  const t0 = performance.now();
  const samples = await textToSpeech({ modelId: args.modelId, text: args.text });
  const pcm = toInt16(samples);
  const ms = performance.now() - t0;
  logPerf({
    ts: new Date().toISOString(),
    phase: args.phase, event: "tts", modelId: args.modelId,
    totalTokens: pcm.length, durationMs: Math.round(ms),
  });
  return { pcm, sampleRate: TTS_SAMPLE_RATE, ms: Math.round(ms) };
}

// GTE_LARGE_FP16 has a 512-token embedding context. Cap chunks well under it (~300 tokens)
// so a single dense chart-PDF "paragraph" can never overflow the embedder. The SDK chunker
// groups by paragraph and does NOT hard-enforce chunkSize on one giant paragraph, so we add a
// deterministic word-boundary hard-split as a safety net.
// Dense clinical text (abbreviations, numbers, dosages) tokenizes at ~2.1 chars/token, far
// below the usual ~4. Measured: a 1200-char chunk = 559 tokens. Cap at 700 chars (~330 tokens)
// for a safe margin under the 512-token embedding context.
const MAX_CHUNK_CHARS = 700;

function hardSplit(s: string, max = MAX_CHUNK_CHARS, overlap = 150): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + max, s.length);
    if (end < s.length) {
      const sp = s.lastIndexOf(" ", end); // prefer a word boundary
      if (sp > i + max * 0.6) end = sp;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= s.length) break;
    i = end - overlap;
  }
  return out;
}

/**
 * Insert paragraph boundaries at SEMANTIC seams before chunking, so the paragraph chunker splits
 * on meaning rather than blind character offsets. Without this, a newline-collapsed chart page is
 * one giant "paragraph" that gets cut mid-row/mid-word — which previously jammed the IMCI SEVERE
 * and PNEUMONIA classification rows into one incoherent chunk.
 * Seams: (1) before IMCI classification colour markers (Pink/Yellow/Green keep each classification
 * whole); (2) after sentence terminators before a capital/number.
 */
export function segmentForChunking(text: string): string {
  return text
    .replace(/\s+(Pink:|Yellow:|Green:)/g, "\n\n$1")
    .replace(/([.;:])\s+(?=[A-Z0-9])/g, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Chunk text through the engine so RAG ingest goes via one gateway (segment + SDK chunker + hard-split). */
export async function chunkText(text: string): Promise<string[]> {
  const chunks = await ragChunk(segmentForChunking(text), {
    chunkSize: 256, chunkOverlap: 50, chunkStrategy: "paragraph",
  });
  return chunks.flatMap((c) => hardSplit(c));
}
