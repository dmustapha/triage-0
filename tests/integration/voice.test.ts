// File: tests/integration/voice.test.ts
// Phase-3 voice gate: the full STT+TTS loop through the orchestrator, end-to-end on the live SDK.
// TTS synthesizes a clinical phrase -> WAV -> Whisper transcribes it back -> assert the key words
// survive the round-trip. Proves Task 3.1 (orchestrator lifecycle) + Task 3.2 (STT/TTS wiring) at once.
//
// Loads supertonic + whisper-tiny (no RAG store needed). SLOW. Self-skips if the models aren't cached
// (offline first run) — it does not download inside the test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));
const wavPath = join(process.env.TRIAGE0_PERF_DIR, "rt.wav");

const { orchestrator } = await import("../../src/qvac/orchestrator.js");
const { ttsTimed, transcribeTimed } = await import("../../src/qvac/engine.js");
const { pcmInt16ToWav } = await import("../../src/qvac/audio.js");
const { registry } = await import("../../src/config.js");

// Heuristic skip: supertonic must be cached (~/.qvac/models holds *supertonic*.gguf after first run).
const { readdirSync } = await import("node:fs");
const cacheDir = join(homedir(), ".qvac", "models");
const cached = existsSync(cacheDir) && readdirSync(cacheDir).some((f) => /supertonic/i.test(f));
const skip = cached ? false : "TTS model not cached — run the app once online first";

after(async () => {
  await orchestrator.shutdown();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

test("STT+TTS round-trip: synthesized speech transcribes back to the same words", { skip, timeout: 300_000 }, async () => {
  const phrase = "Two year old with cough and fast breathing.";

  const { pcm, sampleRate, ms: ttsMs } = await orchestrator.withTts("test", (id) =>
    ttsTimed({ modelId: id, text: phrase, phase: "test" }),
  );
  assert.ok(pcm.length > 1000, `got PCM samples (${pcm.length})`);
  assert.equal(sampleRate, 44100);
  assert.ok(ttsMs >= 0);

  writeFileSync(wavPath, pcmInt16ToWav(pcm, sampleRate));

  const { text } = await orchestrator.withStt("test", (id) =>
    transcribeTimed({ modelId: id, audioChunk: wavPath, phase: "test" }),
  );
  assert.ok(text.length > 0, "non-empty transcript");
  // Whisper-tiny may reformat ("two-year-old"), so match key content words case-insensitively.
  assert.match(text, /cough/i, `transcript mentions cough (got "${text}")`);
  assert.match(text, /breath/i, `transcript mentions breathing (got "${text}")`);
});

test("orchestrator tracks resident roles and shuts down cleanly", { skip, timeout: 60_000 }, async () => {
  const id = await orchestrator.getEmbeddings("test");
  assert.ok(id.length > 0);
  assert.ok(orchestrator.residentRoles().includes("embeddings"));
  assert.equal(registry.embeddings.role, "embeddings");
});
