// File: scripts/spike5-voice.ts
// Phase-3 reconciliation: prove WHISPER_EN_TINY_Q8_0 (STT) + TTS_EN_SUPERTONIC_Q8_0 (TTS) live on
// this M1. The current sdk.ts shim THROWS on the real shapes (transcribe returns a STRING, not {text};
// textToSpeech returns a TextToSpeechStreamResult whose .buffer is Promise<number[]>, not Int16Array).
// Self-contained round-trip: TTS a clinical phrase -> WAV -> Whisper transcribes it back.
//
// Run (online — first load downloads the models): node --import tsx scripts/spike5-voice.ts
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel, unloadModel, transcribe, textToSpeech, close } from "@qvac/sdk";
import * as qvac from "@qvac/sdk";
const TTS_EN_SUPERTONIC_Q8_0 = (qvac as any).TTS_EN_SUPERTONIC_Q8_0;
const WHISPER_EN_TINY_Q8_0 = (qvac as any).WHISPER_EN_TINY_Q8_0;

const PHRASE = "Two year old with cough, chest indrawing, and fast breathing.";

function pcmToInt16(buffer: number[]): { samples: Int16Array; float: boolean } {
  let max = 0;
  for (const v of buffer) max = Math.max(max, Math.abs(v));
  const float = max <= 1.5; // float PCM lives in [-1,1]; int16 PCM is up to 32767
  const samples = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const v = float ? buffer[i] * 32767 : buffer[i];
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return { samples, float };
}

function writeWavInt16(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataSize, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
}

async function main() {
  // ---- TTS ----
  console.log("loading TTS (TTS_EN_SUPERTONIC_Q8_0)…");
  // TTS branch REQUIRES modelConfig (unlike whisper, which is optional). Supertonic engine + language.
  const ttsId = (await loadModel({ modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelConfig: { ttsEngine: "supertonic", language: "en" } } as any)) as string;
  console.log(`TTS modelId=${ttsId}`);
  const t0 = performance.now();
  const res: any = textToSpeech({ modelId: ttsId, text: PHRASE });
  console.log(`textToSpeech result keys: ${JSON.stringify(Object.keys(res))}`);
  // result.buffer does NOT resolve unless the stream is consumed (the multicast back-pressures).
  // Drain bufferStream (the documented consumption path) to collect PCM samples.
  const buffer: number[] = [];
  for await (const s of res.bufferStream as AsyncIterable<number>) buffer.push(s);
  const done = await res.done;
  const ttsMs = Math.round(performance.now() - t0);
  console.log(`TTS ${ttsMs}ms  done=${done}  samples=${buffer.length}  first5=${JSON.stringify(buffer.slice(0, 5))}`);

  const { samples, float } = pcmToInt16(buffer);
  // Derive sample rate: prefer stats; supertonic default is 44100. We'll try a few if STT fails.
  const guessedRate = 44100;
  console.log(`PCM format: ${float ? "float[-1,1]" : "int16"}  -> writing 16-bit WAV @ ${guessedRate}Hz`);
  const wavPath = join(tmpdir(), "triage0-spike-tts.wav");
  writeFileSync(wavPath, writeWavInt16(samples, guessedRate));
  console.log(`wrote ${wavPath}`);

  await unloadModel({ modelId: ttsId } as any);

  // ---- STT ----
  console.log("\nloading STT (WHISPER_EN_TINY_Q8_0)…");
  const sttId = (await loadModel({ modelSrc: WHISPER_EN_TINY_Q8_0 } as any)) as string;
  console.log(`STT modelId=${sttId}`);

  // Try filePath input first (the schema's filePath variant); the client adapts a string path.
  try {
    const s0 = performance.now();
    const text: any = await transcribe({ modelId: sttId, audioChunk: wavPath } as any);
    console.log(`transcribe(filePath) ${Math.round(performance.now() - s0)}ms  typeof=${typeof text}`);
    console.log(`STT text => ${JSON.stringify(text)}`);
  } catch (e: any) {
    console.log(`transcribe(filePath) FAILED: ${e?.message}`);
    // Fallback: pass a Buffer of the WAV bytes.
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(wavPath);
    const text: any = await transcribe({ modelId: sttId, audioChunk: buf } as any);
    console.log(`transcribe(Buffer) typeof=${typeof text}  => ${JSON.stringify(text)}`);
  }

  await unloadModel({ modelId: sttId } as any);
  close();
}
main().catch((e) => { console.error("SPIKE FAILED:", e); try { close(); } catch {} process.exit(1); });
