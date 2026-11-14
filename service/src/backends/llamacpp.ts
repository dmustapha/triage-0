import type { CompleteArgs, CompleteResult, ModelName, RouteBackend } from "./types.js";

export type LlamaCppOpts = { baseUrl: string; model: ModelName; fetchImpl?: typeof fetch };

const HEALTH_TIMEOUT_MS = 5000;

/** llama-server (OpenAI-compatible) behind the same RouteBackend contract as the SDK. */
export function createLlamaCppBackend(opts: LlamaCppOpts): RouteBackend {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function start(): Promise<void> {
    const res = await f(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (res.status !== 200) throw new Error(`llama-server /health returned ${res.status}`);
  }

  async function complete(a: CompleteArgs): Promise<CompleteResult> {
    const t0 = performance.now();
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: a.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "system", content: a.system }, { role: "user", content: a.user }],
        max_tokens: a.maxTokens,
        temperature: 0,
        stream: false,
        response_format: { type: "json_schema", json_schema: { name: "route", schema: a.jsonSchema } },
        // MedPsy is a thinking model: without this it spends the whole token budget inside <think> and returns "".
        chat_template_kwargs: { enable_thinking: false },
        reasoning_budget: 0,
      }),
    });
    if (res.status !== 200) throw new Error(`llama-server returned ${res.status}`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      timings?: { predicted_per_second?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      ttftMs: null,
      totalMs: Math.round(performance.now() - t0),
      tokensPerS: body.timings?.predicted_per_second ?? null,
    };
  }

  return { name: "llamacpp", model: opts.model, start, stop: async () => {}, complete };
}
