// File: src/qvac/audio.ts
// Pure audio helpers (unit-tested). The SDK's supertonic TTS returns int16 PCM samples as number[];
// to play them in a browser <audio>, we wrap them in a 44-byte canonical PCM16 WAV header. The SDK's
// whisper transcribe decodes any WAV/sample-rate via FFmpeg, so a standard mono 16-bit WAV is enough.

/** Clamp a number[] of int16-range PCM samples into a typed Int16Array. */
export function toInt16(samples: number[]): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i]);
    out[i] = v < -32768 ? -32768 : v > 32767 ? 32767 : v;
  }
  return out;
}

/**
 * Encode mono int16 PCM as a canonical 44-byte-header WAV file (PCM, 1 channel, 16-bit).
 * Returns a Buffer ready to write to disk or stream as audio/wav.
 */
export function pcmInt16ToWav(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // audio format = PCM
  b.writeUInt16LE(1, 22); // channels = mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // byte rate = rate * channels * bytesPerSample
  b.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(samples[i], 44 + i * 2);
  return b;
}
