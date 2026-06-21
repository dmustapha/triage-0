// File: tests/unit/config.test.ts
// MODEL-FREE config gate. config.ts reads process.env at module-evaluation time, so we set env vars and
// dynamic-import a FRESH module instance (a unique ?v= query busts the ESM module cache) to observe how
// each override resolves. Proves: MODEL_ID selects the 4B HF URL vs the local 1.7B .gguf; PORT,
// RAG_THRESHOLD, RESIDENT_MODE parse; and the model registry carries every role the orchestrator needs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Snapshot the env keys this module reads, so each test starts from a clean slate.
const KEYS = ["MODEL_ID", "PORT", "RAG_THRESHOLD", "RESIDENT_MODE", "EMBED_SRC", "HF_TOKEN"] as const;
const original: Record<string, string | undefined> = {};
for (const k of KEYS) original[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

let v = 0;
/** Re-evaluate config.ts under the current process.env by busting the ESM cache. */
async function freshConfig() {
  return import(`../../src/config.js?v=${v++}`);
}

test("MODEL_ID=4b -> medpsySpec().modelSrc is the 4B Hugging Face GGUF URL", async () => {
  process.env.MODEL_ID = "4b";
  const { config, medpsySpec } = await freshConfig();
  assert.equal(config.modelId, "4b");
  const spec = medpsySpec();
  assert.match(spec.modelSrc, /^https:\/\/huggingface\.co\//, "4B resolves to the remote HF URL");
  assert.match(spec.modelSrc, /MedPsy-4B-GGUF.*4b-q4_k_m/i);
  assert.equal(spec.modelType, "llm");
  assert.equal(spec.role, "medpsy");
});

test("MODEL_ID uppercase is lowercased (4B -> 4b)", async () => {
  process.env.MODEL_ID = "4B";
  const { config, medpsySpec } = await freshConfig();
  assert.equal(config.modelId, "4b");
  assert.match(medpsySpec().modelSrc, /huggingface\.co/);
});

test("default (no MODEL_ID) -> 1.7b local .gguf path, never a remote URL", async () => {
  delete process.env.MODEL_ID;
  const { config, medpsySpec } = await freshConfig();
  assert.equal(config.modelId, "1.7b");
  const src = medpsySpec().modelSrc;
  assert.match(src, /medpsy-1\.7b-q4_k_m-imat\.gguf$/, "default is the local 1.7B gguf");
  assert.doesNotMatch(src, /^https?:\/\//, "default must NOT be a remote URL (it ships local)");
  assert.equal(medpsySpec().ctxSize, 3072);
});

test("RAG_THRESHOLD parses as a number; default is 0.70", async () => {
  process.env.RAG_THRESHOLD = "0.55";
  const { config } = await freshConfig();
  assert.equal(config.ragScoreThreshold, 0.55);
  assert.equal(typeof config.ragScoreThreshold, "number");

  delete process.env.RAG_THRESHOLD;
  const { config: dft } = await freshConfig();
  assert.equal(dft.ragScoreThreshold, 0.7, "calibrated default floor");
});

test("PORT parses as a number; default is 3010", async () => {
  process.env.PORT = "4321";
  const { config } = await freshConfig();
  assert.equal(config.port, 4321);

  delete process.env.PORT;
  const { config: dft } = await freshConfig();
  assert.equal(dft.port, 3010, "default app port");
});

test("RESIDENT_MODE is taken verbatim; default is 'resident'", async () => {
  process.env.RESIDENT_MODE = "fallback";
  const { config } = await freshConfig();
  assert.equal(config.residentMode, "fallback");

  delete process.env.RESIDENT_MODE;
  const { config: dft } = await freshConfig();
  assert.equal(dft.residentMode, "resident");
});

test("registry carries every role the orchestrator loads (stt/tts/embeddings/medpsy)", async () => {
  delete process.env.MODEL_ID;
  delete process.env.EMBED_SRC;
  const { registry } = await freshConfig();
  assert.equal(registry.stt.role, "stt");
  assert.equal(registry.stt.modelType, "whisper");
  assert.equal(registry.tts.role, "tts");
  assert.equal(registry.tts.modelType, "tts");
  // TTS load REQUIRES a modelConfig (the load-model union's tts branch is non-optional).
  assert.ok(registry.tts.modelConfig, "tts spec carries the required modelConfig");
  assert.equal((registry.tts.modelConfig as { ttsEngine?: string }).ttsEngine, "supertonic");
  assert.equal(registry.embeddings.role, "embeddings");
  assert.equal(registry.embeddings.modelType, "embeddings");
  assert.equal(registry.embeddings.modelSrc, "GTE_LARGE_FP16", "default embedder token");
  assert.equal(registry.medpsy.role, "medpsy");
});

test("EMBED_SRC overrides the embeddings model token", async () => {
  process.env.EMBED_SRC = "SOME_OTHER_EMBED_MODEL";
  const { registry } = await freshConfig();
  assert.equal(registry.embeddings.modelSrc, "SOME_OTHER_EMBED_MODEL");
});
