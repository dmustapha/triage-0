// File: scripts/prewarm-voice.ts
// One-shot pre-cache for the voice models (Whisper STT + Supertonic TTS).
// The server's /tts and /transcribe routes wrap loads in a 30s VOICE_TIMEOUT_MS, which is fine
// once the model blobs are on disk but FAILS on the very first cold download (the Supertonic blob
// download alone exceeds 30s on a fresh machine). This runs the download+load with NO artificial
// timeout, then does a tiny synth to prove the audio is non-silent (C-2), then exits.
// Run with the app server STOPPED so the two SDK workers don't double-load on the 8GB target.
import { loadModelTimed, ttsTimed } from "../src/qvac/engine.js";
import { registry } from "../src/config.js";
import { close } from "../src/qvac/sdk.js";

function nonSilent(pcm: Int16Array): { nonzero: number; peak: number } {
  let nonzero = 0, peak = 0;
  for (const s of pcm) { const a = Math.abs(s); if (a > 5) nonzero++; if (a > peak) peak = a; }
  return { nonzero, peak };
}

async function main() {
  console.log("[prewarm-voice] loading Whisper STT (WHISPER_EN_TINY_Q8_0) — downloads+caches on first run…");
  const stt = await loadModelTimed(registry.stt, "prewarm-stt");
  console.log(`[prewarm-voice] STT loaded in ${Math.round(stt.loadMs)}ms → ${stt.modelId}`);

  console.log("[prewarm-voice] loading Supertonic TTS (TTS_EN_SUPERTONIC_Q8_0) — downloads+caches on first run…");
  const tts = await loadModelTimed(registry.tts, "prewarm-tts");
  console.log(`[prewarm-voice] TTS loaded in ${Math.round(tts.loadMs)}ms → ${tts.modelId}`);

  console.log("[prewarm-voice] synthesizing a test phrase to verify audio is non-silent…");
  const { pcm, sampleRate, ms } = await ttsTimed({
    modelId: tts.modelId,
    text: "Refer urgently and give oral amoxicillin.",
    phase: "prewarm-tts-synth",
  });
  const { nonzero, peak } = nonSilent(pcm);
  console.log(`[prewarm-voice] TTS synth: ${pcm.length} samples @ ${sampleRate}Hz in ${ms}ms; nonzero=${nonzero} peak=${peak}`);
  const audible = nonzero > 1000 && peak > 100;
  console.log(`[prewarm-voice] VERDICT: ${audible ? "AUDIBLE ✅ (C-2 passes)" : "SILENT ❌ (C-2 fails — TTS drain is broken)"}`);

  close();
  process.exit(audible ? 0 : 2);
}

main().catch((err) => {
  console.error("[prewarm-voice] FAILED:", err);
  close();
  process.exit(1);
});
