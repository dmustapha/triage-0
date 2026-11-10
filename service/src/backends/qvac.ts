import { resolveModelSrc, type CompleteArgs, type CompleteResult, type ModelName, type RouteBackend } from "./types.js";

/** The slice of @qvac/sdk 0.23 this service touches. Injectable for tests. */
export type QvacSdkSurface = {
  loadModel(opts: {
    modelSrc: string;
    modelType: "llamacpp-completion";
    modelConfig: { ctx_size: number };
    onProgress?: (p: unknown) => void;
  }): Promise<string>;
  completion(params: {
    modelId: string;
    history: { role: string; content: string }[];
    stream: true;
    responseFormat: { type: "json_schema"; json_schema: { name: string; schema: object } };
    generationParams: { predict: number; temp: number };
  }): {
    requestId: string;
    events: AsyncIterable<{ type: string; text?: string }>;
    final: Promise<{ contentText?: string; stats?: { timeToFirstToken?: number; tokensPerSecond?: number } }>;
  };
  cancel(params: { requestId: string }): Promise<void>;
  unloadModel(params: { modelId: string }): Promise<void>;
  close(): Promise<void> | void;
  getLogger?(namespace: string): { setLevel(level: string): void };
  SDK_ALL_LOG_ID?: string;
};

export type QvacBackendOpts = { model: ModelName; ctxSize: number; sdk?: QvacSdkSurface };

async function realSdk(): Promise<QvacSdkSurface> {
  // Lazy: unit tests and the llama.cpp box never load the bare worker.
  return (await import("@qvac/sdk")) as unknown as QvacSdkSurface;
}

/** The SDK makes its own logger; it must never see stderr (v0 lesson). */
function silenceSdkLogs(sdk: QvacSdkSurface): void {
  try {
    sdk.getLogger?.(sdk.SDK_ALL_LOG_ID ?? "__all__").setLevel("off");
  } catch {
    /* logger API absent: nothing to silence */
  }
}

export function createQvacBackend(opts: QvacBackendOpts): RouteBackend {
  let sdk: QvacSdkSurface | null = null;
  let modelId: string | null = null;

  async function start(): Promise<void> {
    sdk = opts.sdk ?? (await realSdk());
    silenceSdkLogs(sdk);
    modelId = await sdk.loadModel({
      modelSrc: resolveModelSrc(opts.model, process.env),
      modelType: "llamacpp-completion",
      modelConfig: { ctx_size: opts.ctxSize },
    });
  }

  async function stop(): Promise<void> {
    if (sdk && modelId) await sdk.unloadModel({ modelId });
    if (sdk) await sdk.close();
    sdk = null;
    modelId = null;
  }

  async function complete(a: CompleteArgs): Promise<CompleteResult> {
    if (!sdk || !modelId) throw new Error("qvac backend not started");
    const live = sdk;
    const t0 = performance.now();
    let firstDeltaAt: number | null = null;
    const run = live.completion({
      modelId,
      history: [{ role: "system", content: a.system }, { role: "user", content: a.user }],
      stream: true,
      responseFormat: { type: "json_schema", json_schema: { name: "route", schema: a.jsonSchema } },
      generationParams: { predict: a.maxTokens, temp: 0 },
    });
    // A stalled run must not outlive its request: cancel in the SDK, and never leave `final` unobserved.
    run.final.catch(() => {});
    const onAbort = () => { void live.cancel({ requestId: run.requestId }).catch(() => {}); };
    a.signal.addEventListener("abort", onAbort, { once: true });
    const aborted = new Promise<never>((_, rej) => a.signal.addEventListener("abort", () => rej(a.signal.reason), { once: true }));
    try {
      await Promise.race([drain(), aborted]);
      const fin = await Promise.race([run.final, aborted]);
      const totalMs = Math.round(performance.now() - t0);
      const ttftMs = fin.stats?.timeToFirstToken ?? (firstDeltaAt === null ? null : Math.round(firstDeltaAt - t0));
      return { text: fin.contentText ?? "", ttftMs, totalMs, tokensPerS: fin.stats?.tokensPerSecond ?? null };
    } finally {
      a.signal.removeEventListener("abort", onAbort);
    }

    async function drain(): Promise<void> {
      for await (const ev of run.events) {
        if (ev.type === "contentDelta" && firstDeltaAt === null) firstDeltaAt = performance.now();
      }
    }
  }

  return { name: "qvac", model: opts.model, start, stop, complete };
}
