import type { BACKENDS, MODELS } from "../contract.js";

export type BackendName = (typeof BACKENDS)[number];
export type ModelName = (typeof MODELS)[number];

export type CompleteArgs = {
  system: string;
  user: string;
  jsonSchema: object;
  maxTokens: number;
  signal: AbortSignal;
};

export type CompleteResult = {
  text: string;
  ttftMs: number | null;
  totalMs: number;
  tokensPerS: number | null;
};

export interface RouteBackend {
  readonly name: BackendName;
  readonly model: ModelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  complete(args: CompleteArgs): Promise<CompleteResult>;
}

export const MODEL_SOURCES: Record<ModelName, string> = {
  "medpsy-4b": "https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf",
  "medpsy-1.7b": "https://huggingface.co/qvac/MedPsy-1.7B-GGUF/resolve/main/medpsy-1.7b-q4_k_m-imat.gguf",
};

/** Byte-identical weights for both backends: MODEL_DIR points the SDK at the same local GGUF llama-server loads. */
export function resolveModelSrc(model: ModelName, env: NodeJS.ProcessEnv): string {
  const url = MODEL_SOURCES[model];
  if (!env.MODEL_DIR) return url;
  return `${env.MODEL_DIR.replace(/\/$/, "")}/${url.split("/").pop()}`;
}
