# @qvac/sdk reconcile: v0 shim (0.13.3) → 0.23.0

| v0 shim call (0.13.3) | 0.23.0 call | Verified how | Note |
|---|---|---|---|
| `loadModel({ modelSrc, modelType: "llm", ... })` | `loadModel({ modelSrc, modelType: "llamacpp-completion", modelConfig: { ctx_size }, onProgress? })` → `Promise<string>` | `@qvac/inference/dist/schemas/model-types.d.ts` + spike | `"llm"` is gone; MedPsy has no registry constant, loads by HF URL (`src/backends/types.ts` MODEL_SOURCES) |
| `completion({ modelId, history, stream })` | `completion({ modelId, history, stream: true, responseFormat?, generationParams?, tools? })` → `CompletionRun` | `schemas/completion-stream.d.ts:164-278` | `responseFormat` and `tools` are mutually exclusive |
| GBNF grammar string (v0 hand-built) | `responseFormat: { type: "json_schema", json_schema: { name, schema } }` | `completion-stream.d.ts:65-71` + spike | First-class constrained JSON output |
| `n_predict` | `generationParams.predict` | `completion-stream.d.ts:34,245` | Confirmed key name; `temperature` sits beside it |
| `for await (chunk of stream)` strings | `run.events` async iterable; `{ type: "contentDelta", text }` | `completion-stream.d.ts:401` | Other event types ignored by the shim |
| concatenated text | `run.final` → `{ contentText, stats }` | `completion-stream.d.ts` + spike | |
| hand-timed TTFT | `stats.timeToFirstToken`, `stats.tokensPerSecond`, `promptTokens`, `generatedTokens`, `backendDevice` (all optional) | `completion-stream.d.ts:437-438` | Shim falls back to wall-clock first delta |
| `unloadModel(modelId)` | `unloadModel({ modelId })` | `sdk/dist/src/index.d.ts` | |
| `close()` | `close()` | same | |
| zod 3 + `scripts/patch-sdk-zod.mjs` postinstall | zod 4.6.5 inside SDK; service uses zod ^4 | `npm ls zod` | Postinstall patch dropped |
| darwin-arm64 only tested | `@qvac/fabric-linux-arm64`, `bare-runtime 1.34.1` linux-arm64 prebuilds present | tarball inspection; live proof in Task 9 on the A1 box | |

## Spike output (Mac, medpsy-1.7b)
See below, pasted verbatim after the run.

## Open items
(none yet)
