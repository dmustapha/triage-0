// File: src/qvac/sdk.ts
// Typed re-export shim over @qvac/sdk. RECONCILED LIVE against @qvac/sdk@0.13.3 on M1
// (2026-06-18). The rest of Triage-0 imports from THIS shim, never from @qvac/sdk directly,
// so all SDK-shape reconciliation lives here. Verified shapes: see RECONCILE.md +
// dist/client/api/{embed,rag,completion,load-model}.d.ts.
import * as qvac from "@qvac/sdk";

/** Native per-completion stats surfaced on `final.stats` (engine.completionTimed).
 *  Verified live shape (RECONCILE.md Phase-2): the addon reports `generatedTokens` + `promptTokens`
 *  (+ `cacheTokens`), NOT `totalTokens`. Kept `totalTokens` optional for back-compat. */
export interface QvacStats {
  timeToFirstToken: number; // ms
  tokensPerSecond: number;
  generatedTokens?: number;
  promptTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  backendDevice: string; // e.g. "gpu"
}

export interface QvacCompletionEvent {
  type?: string; // "contentDelta" | ...
  text?: string; // delta payload on contentDelta events
  contentDelta?: string;
  content?: string;
  delta?: string;
}

export interface QvacCompletionFinal {
  contentText?: string;
  text?: string;
  content?: string;
  toolCalls?: unknown[];
  tool_calls?: unknown[];
  stats: QvacStats;
}

export interface QvacCompletionRun {
  events: AsyncIterable<QvacCompletionEvent>;
  final: Promise<QvacCompletionFinal>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface LoadModelArgs {
  modelSrc: string; // a built-in constant TOKEN, a URL, or a local path
  modelType?: string;
  modelConfig?: { ctx_size?: number; tools?: unknown[] };
}

/** Native RAG search hit (verified: ragSearch returns id+content+score only). */
export interface RagHit {
  id: string;
  content: string;
  score: number;
}

/** A pre-embedded document for ragSaveEmbeddings. */
export interface RagEmbeddedDoc {
  id: string;
  content: string;
  embedding: number[];
  embeddingModelId: string;
  metadata?: Record<string, unknown>;
}

/** Per-document result from ragSaveEmbeddings (verified shape: {status, id, error?}). */
export interface RagSaveResult {
  status: "fulfilled" | "rejected";
  id?: string;
  error?: string;
}

// Resolve a built-in constant TOKEN to its real exported value (string OR descriptor
// object, e.g. GTE_LARGE_FP16 = { name, src }). If the token is not an export (URL/path),
// it is returned unchanged so loadModel treats it as a direct source.
function resolveSrc(token: string): unknown {
  const map = qvac as unknown as Record<string, unknown>;
  if (token in map && map[token] != null) return map[token];
  return token;
}

export const loadModel = async (args: LoadModelArgs): Promise<string> => {
  const resolved = { ...args, modelSrc: resolveSrc(args.modelSrc) };
  const res = (await (qvac as any).loadModel(resolved)) as unknown;
  if (typeof res === "string") return res;
  const obj = res as { modelId?: string; id?: string };
  return obj.modelId ?? obj.id ?? String(res);
};

export const unloadModel = async (modelId: string): Promise<void> => {
  await (qvac as any).unloadModel({ modelId });
};

export const completion = (args: {
  modelId: string;
  history: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  /** llama.cpp sampling knobs. Token cap = `predict` (there is NO top-level maxTokens — RECONCILE.md). */
  generationParams?: { predict?: number; temp?: number; reasoning_budget?: -1 | 0; [k: string]: unknown };
  /** GBNF-constrained structured output, e.g. { type:"json_schema", json_schema:{ name, schema } }. */
  responseFormat?: unknown;
}): QvacCompletionRun => {
  return (qvac as any).completion(args) as QvacCompletionRun;
};

// RECONCILED live (Phase 3, RECONCILE.md): transcribe returns a plain STRING (not {text}); audioChunk
// is a file PATH (string) or a buffer — the SDK decodes any sample rate via FFmpeg internally.
export const transcribe = async (args: {
  modelId: string;
  audioChunk: string | Buffer | Uint8Array;
  prompt?: string;
}): Promise<{ text: string }> => {
  const res = (await (qvac as any).transcribe(args)) as string | { text?: string };
  if (typeof res === "string") return { text: res };
  if (res && typeof res.text === "string") return { text: res.text };
  throw new Error(`transcribe: unexpected return shape ${JSON.stringify(Object.keys(res ?? {}))}`);
};

// RECONCILED live (Phase 3): textToSpeech returns a TextToSpeechStreamResult; result.buffer DEADLOCKS
// unless the stream is consumed, so we DRAIN result.bufferStream (int16 PCM samples) then await done.
export const textToSpeech = async (args: {
  modelId: string;
  text: string;
}): Promise<number[]> => {
  const res = (await (qvac as any).textToSpeech(args)) as {
    bufferStream?: AsyncIterable<number>;
    buffer?: Promise<number[]>;
    done?: Promise<boolean>;
  };
  if (res?.bufferStream) {
    const pcm: number[] = [];
    for await (const s of res.bufferStream) pcm.push(s);
    if (res.done) await res.done;
    return pcm;
  }
  // Defensive: if a future SDK resolves buffer without back-pressure, accept it.
  if (res?.buffer) return await res.buffer;
  throw new Error(`textToSpeech: unexpected return shape ${JSON.stringify(Object.keys(res ?? {}))}`);
};

/** Single-text embedding -> number[]. (Verified: embed returns { embedding, stats }.) */
export const embed = async (args: { modelId: string; text: string }): Promise<number[]> => {
  const res = (await (qvac as any).embed(args)) as { embedding: number[] };
  return res.embedding;
};

/** Batch embedding -> number[][] (one vector per input text). */
export const embedBatch = async (args: { modelId: string; text: string[] }): Promise<number[][]> => {
  if (args.text.length === 0) return [];
  const res = (await (qvac as any).embed(args)) as { embedding: number[][] };
  return res.embedding;
};

// ── Native @qvac/rag primitives (verified shapes) ───────────────────────────────

/** Chunk text via the SDK chunker -> array of chunk contents. */
export const ragChunk = async (
  text: string,
  opts?: { chunkSize?: number; chunkOverlap?: number; chunkStrategy?: "paragraph" | "character" },
): Promise<string[]> => {
  const docs = (await (qvac as any).ragChunk({
    documents: [text],
    chunkOpts: {
      chunkSize: opts?.chunkSize ?? 256,
      chunkOverlap: opts?.chunkOverlap ?? 50,
      chunkStrategy: opts?.chunkStrategy ?? "paragraph",
    },
  })) as Array<{ id: string; content: string }>;
  return docs.map((d) => d.content).filter((c) => c.trim().length > 0);
};

/** Persist pre-embedded docs into the native vector store; returns per-doc fulfilled/rejected. */
export const ragSaveEmbeddings = async (args: {
  workspace: string;
  documents: RagEmbeddedDoc[];
}): Promise<RagSaveResult[]> => {
  const res = (await (qvac as any).ragSaveEmbeddings(args)) as unknown;
  // Verified: returns RagSaveResult[] directly. Tolerate a {processed} wrapper just in case.
  if (Array.isArray(res)) return res as RagSaveResult[];
  const wrapped = (res as { processed?: RagSaveResult[] })?.processed;
  return Array.isArray(wrapped) ? wrapped : [];
};

/** Semantic search; embeds the query internally with `modelId`. Returns id+content+score. */
export const ragSearch = async (args: {
  modelId: string;
  query: string;
  topK?: number;
  workspace: string;
}): Promise<RagHit[]> => {
  return (await (qvac as any).ragSearch({
    modelId: args.modelId,
    query: args.query,
    topK: args.topK ?? 5,
    workspace: args.workspace,
  })) as RagHit[];
};

/**
 * Rebuild the IVF k-means centroids over the whole workspace. REQUIRED after bulk ingest:
 * without it, HyperDB search recall is poor (returns wrong/approximate neighbours). Needs
 * ≥16 docs to cluster; returns {reindexed:false} below that (small corpora use exact search).
 * Verified on M1 2026-06-18: pre-reindex pneumonia query missed all IMCI chunks; post-reindex
 * the correct IMCI severe-pneumonia chunk ranks #1 @0.79.
 */
export const ragReindex = async (workspace: string): Promise<{ reindexed: boolean }> => {
  return (await (qvac as any).ragReindex({ workspace })) as { reindexed: boolean };
};

export const ragDeleteWorkspace = async (workspace: string): Promise<void> => {
  try {
    await (qvac as any).ragDeleteWorkspace({ workspace });
  } catch {
    // workspace did not exist — idempotent no-op
  }
};

export const ragListWorkspaces = async (): Promise<Array<{ name: string; open: boolean }>> => {
  return (await (qvac as any).ragListWorkspaces()) as Array<{ name: string; open: boolean }>;
};

/** Release SDK runtime resources (kills the bare worker). Call once at shutdown. */
export const close = (): void => {
  try {
    (qvac as any).close?.();
  } catch {
    /* noop */
  }
};
