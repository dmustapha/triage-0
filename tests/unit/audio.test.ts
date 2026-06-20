// File: tests/unit/audio.test.ts
// Pins the WAV encoder + PCM clamp (audio.ts) — pure, fast, no model. A malformed header would make
// the browser <audio> silent and break the voice loop, so the byte layout is asserted exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmInt16ToWav, toInt16 } from "../../src/qvac/audio.js";

test("toInt16 rounds and clamps to int16 range", () => {
  const out = toInt16([0, 1.6, -1.4, 40000, -40000, 32767, -32768]);
  assert.deepEqual(Array.from(out), [0, 2, -1, 32767, -32768, 32767, -32768]);
});

test("pcmInt16ToWav writes a canonical 44-byte PCM16 mono header", () => {
  const samples = Int16Array.from([0, 100, -100, 32767, -32768]);
  const rate = 44100;
  const wav = pcmInt16ToWav(samples, rate);

  assert.equal(wav.length, 44 + samples.length * 2, "header + 2 bytes/sample");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + samples.length * 2, "RIFF chunk size");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1, "PCM format");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), rate, "sample rate");
  assert.equal(wav.readUInt32LE(28), rate * 2, "byte rate");
  assert.equal(wav.readUInt16LE(32), 2, "block align");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), samples.length * 2, "data chunk size");
  // round-trip a couple of samples
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(46), 100);
  assert.equal(wav.readInt16LE(50), 32767);
});
