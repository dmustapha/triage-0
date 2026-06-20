// File: tests/unit/severity.test.ts
// Pins the deterministic WHO-classification -> triage-severity mapping (severity.ts). This is the band
// that the model does NOT author (RECONCILE.md Phase-2), so it must be exhaustively tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToSeverity, hasEmergencySign, finalizeSeverity } from "../../src/triage/severity.js";

test("severe / danger-sign / refer-urgently -> EMERGENCY", () => {
  assert.equal(classifyToSeverity("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "give first dose of antibiotic, refer URGENTLY to hospital"), "EMERGENCY");
  assert.equal(classifyToSeverity("VERY SEVERE FEBRILE DISEASE", "refer urgently"), "EMERGENCY");
  assert.equal(classifyToSeverity("PNEUMONIA", "any general danger sign present — refer immediately"), "EMERGENCY");
  assert.equal(classifyToSeverity("SEVERE DEHYDRATION", "Plan C, refer urgently"), "EMERGENCY");
});

test("chest-indrawing PNEUMONIA with home antibiotic -> URGENT (the correctness-gate band)", () => {
  // The hero case: 2014 IMCI merged chest indrawing into PNEUMONIA (home oral amoxicillin), NOT severe.
  assert.equal(classifyToSeverity("PNEUMONIA", "give oral Amoxicillin for 5 days, follow-up in 3 days"), "URGENT");
});

test("named treatable conditions + home medicine -> URGENT", () => {
  assert.equal(classifyToSeverity("SOME DEHYDRATION", "give ORS solution, Plan B"), "URGENT");
  assert.equal(classifyToSeverity("DYSENTERY", "give ciprofloxacin, follow-up in 3 days"), "URGENT");
  assert.equal(classifyToSeverity("MODERATE DEPRESSION", "psychoeducation, follow-up in 2 weeks"), "URGENT");
});

test("explicit mild / negation classifications -> ROUTINE (not caught by the PNEUMONIA token)", () => {
  assert.equal(classifyToSeverity("NO PNEUMONIA: COUGH OR COLD", "advise the mother on home care, return if worse"), "ROUTINE");
  assert.equal(classifyToSeverity("NO DEHYDRATION", "Plan A, continue feeding, advise mother"), "ROUTINE");
});

test("a matched protocol with an unclear band defaults to URGENT (safe, non-emergency)", () => {
  assert.equal(classifyToSeverity("SOME CLASSIFICATION", "do the thing"), "URGENT");
  assert.equal(classifyToSeverity("", ""), "URGENT");
});

test("NOT SEVERE / NON-SEVERE do NOT trip EMERGENCY (lookbehind) -> URGENT via named token", () => {
  // The "severe" prior bleeds into negated wordings; the lookbehind keeps them out of EMERGENCY.
  assert.equal(classifyToSeverity("NON-SEVERE PNEUMONIA", "give oral amoxicillin, follow-up in 3 days"), "URGENT");
  assert.equal(classifyToSeverity("PNEUMONIA, NOT SEVERE", "oral antibiotic at home"), "URGENT"); // still needs antibiotics
  assert.equal(classifyToSeverity("NON SEVERE DEHYDRATION", "give ORS, Plan B"), "URGENT");
  // Bare SEVERE still escalates.
  assert.equal(classifyToSeverity("SEVERE PNEUMONIA", "refer urgently"), "EMERGENCY");
});

test("hasEmergencySign catches plain-language emergencies (expanded danger wording)", () => {
  assert.equal(hasEmergencySign("baby has not been able to drink since morning", []), true);
  assert.equal(hasEmergencySign("child went floppy and very sleepy", []), true);
  assert.equal(hasEmergencySign("lips turned blue, gasping for air", []), true);
  assert.equal(hasEmergencySign("infant stopped breathing briefly, now drowsy", []), true);
  assert.equal(hasEmergencySign("unresponsive when called", []), true);
  // Still negation-aware on the new wordings.
  assert.equal(hasEmergencySign("no cyanosis, not drowsy, drinking well", []), false);
});

test("finalizeSeverity SCOPED downgrade: only a pure pneumonia-sign EMERGENCY is downgraded", () => {
  // Pure pneumonia-sign presentation, no danger sign -> downgrade to URGENT.
  assert.equal(
    finalizeSeverity("SEVERE PNEUMONIA", "refer urgently", "chest indrawing, breathing 52 a minute, alert", []),
    "URGENT",
  );
  // A non-pneumonia EMERGENCY with no pneumonia sign is LEFT as EMERGENCY (safe over-call, not silently downgraded).
  assert.equal(
    finalizeSeverity("SEVERE DEHYDRATION", "Plan C, refer urgently", "sunken eyes, skin pinch very slow", []),
    "EMERGENCY",
  );
  // Plain-language danger sign present -> keeps EMERGENCY even with a pneumonia sign also present.
  assert.equal(
    finalizeSeverity("SEVERE PNEUMONIA", "refer urgently", "chest indrawing and now floppy and unable to drink", []),
    "EMERGENCY",
  );
});

test("hasEmergencySign detects real danger signs (negation-aware)", () => {
  assert.equal(hasEmergencySign("lethargic and unable to drink, stridor while calm", []), true);
  assert.equal(hasEmergencySign("child had convulsions this morning", []), true);
  assert.equal(hasEmergencySign("alert and drinking, no danger signs", ["Chest indrawing"]), false);
  assert.equal(hasEmergencySign("chest indrawing and fast breathing 52/min", []), false); // not danger signs alone
  assert.equal(hasEmergencySign("no stridor, denies vomiting everything", []), false); // negated
  assert.equal(hasEmergencySign("expressing thoughts of suicide", []), true); // mhGAP imminent risk
});

test("finalizeSeverity GATE: EMERGENCY only when a danger sign is actually present", () => {
  // The hero invariant: model over-escalates chest indrawing -> downgraded to URGENT (no danger sign).
  assert.equal(
    finalizeSeverity("SEVERE PNEUMONIA", "refer urgently", "chest indrawing, breathing 52/min, alert, drinking, no danger signs", ["Chest indrawing"]),
    "URGENT",
  );
  // A real danger-sign case keeps EMERGENCY (sign present in the case).
  assert.equal(
    finalizeSeverity("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "give first dose, refer urgently", "lethargic, unable to drink, stridor", ["lethargy", "stridor"]),
    "EMERGENCY",
  );
  // Non-emergency bands pass through untouched.
  assert.equal(finalizeSeverity("PNEUMONIA", "oral amoxicillin 5 days", "chest indrawing, no danger signs", []), "URGENT");
  assert.equal(finalizeSeverity("NO PNEUMONIA: COUGH OR COLD", "advise home care", "mild cough", []), "ROUTINE");
});
