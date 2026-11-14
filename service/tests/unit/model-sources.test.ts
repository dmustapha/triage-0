import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelSrc } from "../../src/backends/types.js";

test("resolveModelSrc returns the HF URL by default and a local file when MODEL_DIR is set", () => {
  assert.match(resolveModelSrc("medpsy-4b", {}), /^https:\/\/huggingface\.co\/.*medpsy-4b-q4_k_m-imat\.gguf$/);
  assert.equal(resolveModelSrc("medpsy-1.7b", { MODEL_DIR: "/opt/triage0/models" }), "/opt/triage0/models/medpsy-1.7b-q4_k_m-imat.gguf");
});
