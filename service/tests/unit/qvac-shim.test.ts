import { test } from "node:test";
import assert from "node:assert/strict";
import { createQvacBackend, type QvacSdkSurface } from "../../src/backends/qvac.js";

type FakeOpts = { deltas: string[]; contentText: string; stats: Record<string, number> };

function fakeSdk(o: FakeOpts) {
  const calls: { load?: Record<string, unknown>; completion?: Record<string, unknown>; unloaded?: string; closed: boolean } = { closed: false };
  const sdk: QvacSdkSurface = {
    loadModel: async (opts) => { calls.load = opts as Record<string, unknown>; return "model-1"; },
    completion: (params) => {
      calls.completion = params as Record<string, unknown>;
      async function* events() { for (const text of o.deltas) yield { type: "contentDelta", text }; }
      return { events: events(), final: Promise.resolve({ contentText: o.contentText, stats: o.stats }) };
    },
    unloadModel: async ({ modelId }) => { calls.unloaded = modelId; },
    close: async () => { calls.closed = true; },
  };
  return { sdk, calls };
}

const args = { system: "s", user: "u", jsonSchema: { type: "object" }, maxTokens: 64, signal: new AbortController().signal };

test("complete() drains contentDelta events and returns final.contentText with stats", async () => {
  const { sdk, calls } = fakeSdk({ deltas: ['{"candidates":', '["choking"]}'], contentText: '{"candidates":["choking"]}', stats: { timeToFirstToken: 120, tokensPerSecond: 9.5 } });
  const b = createQvacBackend({ model: "medpsy-1.7b", ctxSize: 2048, sdk });
  await b.start();
  const r = await b.complete(args);
  assert.equal(r.text, '{"candidates":["choking"]}');
  assert.equal(r.ttftMs, 120);
  assert.equal(r.tokensPerS, 9.5);
  const rf = calls.completion!.responseFormat as { type: string };
  assert.equal(rf.type, "json_schema");
  assert.equal(calls.completion!.tools, undefined);
});

test("complete() passes maxTokens as generationParams.predict", async () => {
  const { sdk, calls } = fakeSdk({ deltas: [], contentText: "{}", stats: {} });
  const b = createQvacBackend({ model: "medpsy-1.7b", ctxSize: 2048, sdk });
  await b.start();
  const r = await b.complete({ ...args, maxTokens: 77 });
  assert.deepEqual(calls.completion!.generationParams, { predict: 77, temperature: 0 });
  assert.equal(r.ttftMs, null);
});

test("start() loads with modelType 'llamacpp-completion' and the medpsy URL; stop() unloads and closes", async () => {
  const { sdk, calls } = fakeSdk({ deltas: [], contentText: "{}", stats: {} });
  const b = createQvacBackend({ model: "medpsy-4b", ctxSize: 4096, sdk });
  await b.start();
  assert.equal(calls.load!.modelType, "llamacpp-completion");
  assert.match(String(calls.load!.modelSrc), /MedPsy-4B-GGUF.*medpsy-4b-q4_k_m-imat\.gguf$/);
  assert.deepEqual(calls.load!.modelConfig, { ctx_size: 4096 });
  await b.stop();
  assert.equal(calls.unloaded, "model-1");
  assert.equal(calls.closed, true);
});

test("complete() before start() rejects", async () => {
  const { sdk } = fakeSdk({ deltas: [], contentText: "{}", stats: {} });
  const b = createQvacBackend({ model: "medpsy-1.7b", ctxSize: 2048, sdk });
  await assert.rejects(() => b.complete(args), /not started/);
});
