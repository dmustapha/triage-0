// File: tests/unit/translation.test.ts
// Phase 4 — MODEL-FREE tests for language detection + the no-op English path. Bergamot translation itself
// needs the SDK models (integration, tests/integration/triage.test.ts), so it is NOT exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSourceLanguage } from "../../src/qvac/translation.js";
import { textbookCases, failureCases } from "../../scripts/audit-cases.js";

test("detectSourceLanguage: the NE failure cases are detected as French / Spanish", () => {
  const ne = failureCases.filter((c) => c.failureClass === "non-english");
  assert.ok(ne.length >= 4, `expected the 4 NE cases, got ${ne.length}`);
  for (const c of ne) {
    const lang = detectSourceLanguage(c.input);
    // NE1/NE2 are French, NE3/NE4 Spanish (per audit-cases). Either way it must be a SUPPORTED non-English
    // code so the case gets translated before routing.
    assert.ok(lang === "fr" || lang === "es", `${c.name}: detected "${lang}", expected fr|es`);
  }
});

test("detectSourceLanguage: French / Spanish clinical prose routes to fr / es", () => {
  assert.equal(detectSourceLanguage("Enfant de 2 ans, toux depuis 3 jours, respiration rapide à 54 par minute, tirage sous-costal."), "fr");
  assert.equal(detectSourceLanguage("Niño de 3 años en una zona de paludismo, fiebre desde hace 4 días, sin prueba de malaria."), "es");
});

test("detectSourceLanguage: NO English case is ever mis-flagged for translation (the safety guard)", () => {
  // Every ENGLISH case in the suite (all textbook cases + the non-NE failure cases) MUST detect as "en",
  // else it would be wrongly translated and its routing corrupted. This is the guard behind the
  // no-probability-floor decision (clinical FR scores ~0.45, so a floor would instead drop real French).
  const english = [
    ...textbookCases,
    ...failureCases.filter((c) => c.failureClass !== "non-english"),
  ];
  for (const c of english) {
    assert.equal(detectSourceLanguage(c.input), "en", `${c.name}: English case mis-detected as non-English`);
  }
});

test("detectSourceLanguage: empty / whitespace / gibberish falls back to en (no crash)", () => {
  assert.equal(detectSourceLanguage(""), "en");
  assert.equal(detectSourceLanguage("   "), "en");
  assert.equal(detectSourceLanguage("xxxxx zzzzz qqqqq"), "en");
});
