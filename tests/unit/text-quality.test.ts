// Unit tests for the PDF text-quality guards that keep CID-glyph garbage out of the corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePdfText, looksLikeEnglish, usableChunk } from "../../src/rag/ingest.js";

test("normalizePdfText rejoins line-broken words and strips footers", () => {
  const raw = "Count the\nbreaths in\none minute. Page 3 of 80";
  const out = normalizePdfText(raw);
  assert.equal(out, "Count the breaths in one minute.");
});

test("normalizePdfText repairs the °C glyph artifact", () => {
  assert.match(normalizePdfText("temperature 37.5 & C or above"), /37\.5°C/);
});

test("looksLikeEnglish accepts real clinical prose", () => {
  assert.ok(looksLikeEnglish("Give oral amoxicillin for 5 days if the child has fast breathing"));
  assert.ok(looksLikeEnglish("Refer the child urgently to hospital if any general danger sign"));
});

test("looksLikeEnglish rejects CID-glyph cipher garbage", () => {
  // The booklet's back-page recording forms extract as cipher text like this.
  assert.equal(looksLikeEnglish("7HPSHUDWXUH 3DJHRI 1DPH $JH :HLJKW"), false);
  assert.equal(looksLikeEnglish("&&&&& %%%%% 12345 ////"), false);
});

test("usableChunk requires both lexical content AND English-ness", () => {
  assert.equal(usableChunk("ab cd"), false); // too short
  assert.equal(usableChunk("7HPSHUDWXUH 3DJHRI 1DPH $JH :HLJKW &&&"), false); // glyph garbage
  assert.ok(usableChunk("The child is not able to drink and has had convulsions, refer urgently."));
});
