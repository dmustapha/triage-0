// File: tests/unit/severity.test.ts
// Pins the deterministic WHO-classification -> triage-severity mapping (severity.ts). This is the band
// that the model does NOT author (RECONCILE.md Phase-2), so it must be exhaustively tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyToSeverity, hasEmergencySign, finalizeSeverity, finalizeSeverityV2 } from "../../src/triage/severity.js";

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

test("named treatable condition beats counselling phrases in the action -> URGENT (no under-call)", () => {
  // F3: a real treatable-condition action often contains counselling phrases ("advise the mother",
  // "continue feeding"). Those must NOT down-band a NAMED condition to ROUTINE (home care) — that is a
  // dangerous under-call (a child needing antibiotics sent home). The named diagnosis wins over ROUTINE.
  assert.equal(classifyToSeverity("PNEUMONIA", "Give amoxicillin and advise the mother to return"), "URGENT");
  assert.equal(classifyToSeverity("SOME DEHYDRATION", "give ORS and continue feeding"), "URGENT");
  assert.equal(classifyToSeverity("DYSENTERY", "ciprofloxacin; advise the mother on home care"), "URGENT");
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

test("hasEmergencySign: clause-scoped negation (no thoughts of self-harm) + lay suicidality", () => {
  // "no thoughts of self-harm" must NOT escalate (the comma-clause carries the negation)
  assert.equal(hasEmergencySign("6 weeks of persistent sadness, poor appetite, no thoughts of self-harm"), false);
  // a real danger sign across a "but" clause MUST still escalate
  assert.equal(hasEmergencySign("child with no fever but is unconscious"), true);
  // negated convulsion stays safe; lay suicidality escalates
  assert.equal(hasEmergencySign("fever, no convulsions, alert and drinking"), false);
  assert.equal(hasEmergencySign("low mood, says life isn't worth living"), true);
});

test("classifyToSeverity: a named treatable condition with counselling phrases is URGENT, not ROUTINE (no under-call)", () => {
  // P0 guard: "advise the mother / continue feeding" must NOT down-band a treatable condition to home care.
  assert.equal(classifyToSeverity("PNEUMONIA", "Give amoxicillin. Advise the mother to continue feeding."), "URGENT");
  assert.equal(classifyToSeverity("DYSENTERY", "Give ciprofloxacin. Continue feeding."), "URGENT");
  // genuinely mild / negated classes still band ROUTINE
  assert.equal(classifyToSeverity("COUGH OR COLD", "Soothe the throat, advise the mother, continue feeding."), "ROUTINE");
  assert.equal(classifyToSeverity("NO DEHYDRATION", "Give fluid and continue feeding (Plan A)."), "ROUTINE");
});

// ── finalizeSeverityV2 — the REDESIGN (Tier B) ──────────────────────────────────

test("finalizeSeverityV2: table-encoded classification uses frozen severity (not heuristic)", () => {
  // PNEUMONIA in the protocol table is YELLOW → URGENT, action is "give oral Amoxicillin for 5 days".
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral Amoxicillin for 5 days", "chest indrawing, breathing 52/min, alert, no danger signs", []),
    "URGENT",
  );
  // COUGH OR COLD in the table is GREEN → ROUTINE.
  assert.equal(
    finalizeSeverityV2("COUGH OR COLD", "soothe the throat, advise the mother", "mild cough, no fever", []),
    "ROUTINE",
  );
  // SEVERE PNEUMONIA OR VERY SEVERE DISEASE → EMERGENCY (PINK).
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "give first dose, refer urgently", "stridor, unable to drink, convulsions", ["convulsions"]),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: fallback to heuristic when classification is not table-encoded", () => {
  // "SOME RARE CLASSIFICATION" is not in the table — falls back to classifyToSeverity.
  assert.equal(
    finalizeSeverityV2("SOME RARE CLASSIFICATION", "give ORS, follow up", "mild diarrhoea, alert", []),
    "URGENT",
  );
  // Empty classification → URGENT (safe default from classifyToSeverity).
  assert.equal(
    finalizeSeverityV2("", "", "no real case", []),
    "URGENT",
  );
});

test("finalizeSeverityV2: danger sign ESCALATES any band to EMERGENCY (NEW)", () => {
  // This is the key NEW behavior: a genuine danger sign overrides even a ROUTINE or URGENT table band.
  // PNEUMONIA is URGENT in the table, but "unable to drink" is a danger sign → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral Amoxicillin for 5 days", "chest indrawing and unable to drink since morning", []),
    "EMERGENCY",
  );
  // COUGH OR COLD is ROUTINE in the table, but convulsions → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("COUGH OR COLD", "soothe the throat", "mild cough but had convulsions this morning", []),
    "EMERGENCY",
  );
  // mhGAP: DEPRESSION is URGENT, but suicide ideation is a danger sign → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("DEPRESSION", "psychoeducation, follow-up in 2 weeks", "low mood, says she wants to die, better off dead", []),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: downgrade pure pneumonia-sign EMERGENCY without danger → URGENT", () => {
  // SEVERE PNEUMONIA is EMERGENCY in the table, but chest indrawing alone (no danger sign) → URGENT.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "give first dose, refer urgently", "chest indrawing, breathing 52/min, alert, drinking well", ["Chest indrawing"]),
    "URGENT",
  );
  // With breathing rate explicitly stated.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", "fast breathing at 60 breaths per minute, alert, no danger signs", []),
    "URGENT",
  );
});

test("finalizeSeverityV2: non-pneumonia EMERGENCY without danger sign stays EMERGENCY", () => {
  // SEVERE DEHYDRATION is EMERGENCY (table), no pneumonia sign, no danger sign → stays EMERGENCY.
  // The downgrade guard only fires when a pneumonia sign IS present.
  assert.equal(
    finalizeSeverityV2("SEVERE DEHYDRATION", "Plan C, refer urgently", "sunken eyes, skin pinch very slow, no danger signs", []),
    "EMERGENCY",
  );
  // SEVERE PERSISTENT DIARRHOEA is EMERGENCY in the table — no pneumonia signs → stays EMERGENCY.
  assert.equal(
    finalizeSeverityV2("SEVERE PERSISTENT DIARRHOEA", "refer urgently", "diarrhoea for 18 days, lethargic", []),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: danger sign outranks the downgrade — escalation wins", () => {
  // A case that has BOTH a pneumonia sign AND a danger sign: escalation to EMERGENCY must win.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", "chest indrawing, now floppy and unable to drink", ["floppy"]),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: negation-safe — negated danger signs do NOT escalate", () => {
  // "no convulsions" must NOT escalate to EMERGENCY. Table says PNEUMONIA → URGENT, stays URGENT.
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral Amoxicillin for 5 days", "chest indrawing, fever, no convulsions, alert and drinking", []),
    "URGENT",
  );
  // "no thoughts of self-harm" must NOT escalate DEPRESSION from URGENT.
  assert.equal(
    finalizeSeverityV2("DEPRESSION", "psychoeducation", "low mood, poor sleep, no thoughts of self-harm", []),
    "URGENT",
  );
});

// ── finalizeSeverityV2 edge cases ─────────────────────────────────────────────

test("finalizeSeverityV2: danger sign in redFlags escalates even when caseText alone wouldn't", () => {
  // redFlags carry model-detected signs. A danger sign in redFlags but only mentioned
  // obliquely in caseText must still escalate.
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral amoxicillin", "fever and cough for 3 days, chest indrawing", ["unable to drink"]),
    "EMERGENCY",
  );
  // Non-danger redFlag does NOT escalate.
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral amoxicillin", "chest indrawing, alert", ["fever", "cough"]),
    "URGENT",
  );
});

test("finalizeSeverityV2: downgrade only fires when PNEUMONIA_SIGN_RE matches — not on other respiratory words", () => {
  // "stridor" alone (without chest indrawing / fast breathing / breathing rate) is a danger sign,
  // so it escalates. But if it were NOT a danger sign, it would not trigger the pneumonia downgrade.
  // Test: cough alone is a respiratory word but NOT a pneumonia sign → no downgrade → stays EMERGENCY.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", "persistent cough, fever, no danger signs", []),
    "EMERGENCY", // stays EMERGENCY — cough ≠ pneumonia sign for downgrade purposes
  );
  // "wheezing" is respiratory but NOT a pneumonia sign → no downgrade → stays EMERGENCY.
  // NOTE: must avoid "chest indrawing" even in negated form — PNEUMONIA_SIGN_RE is substring-based.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", "wheezing only, no respiratory distress, no danger signs", []),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: breathing rate formats all match PNEUMONIA_SIGN_RE", () => {
  // Various ways breathing rates appear in case text — all must trigger the downgrade guard.
  const formats = [
    "breathing at 52",
    "breathing 60/min",
    "52 breaths per minute",
    "60 bpm",
    "RR 48/min",
  ];
  for (const fmt of formats) {
    assert.equal(
      finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", `${fmt}, alert, no danger signs`, []),
      "URGENT",
      `breathing format "${fmt}" must trigger pneumonia downgrade`,
    );
  }
});

test("finalizeSeverityV2: whitespace-normalised classification matches table key", () => {
  // normalizeClassification trims and collapses whitespace — test that it works.
  assert.equal(
    finalizeSeverityV2("  PNEUMONIA  ", "give oral Amoxicillin", "chest indrawing, no danger signs", []),
    "URGENT",
  );
  assert.equal(
    finalizeSeverityV2("severe pneumonia or very severe disease", "refer urgently", "stridor, lethargic", ["lethargic"]),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: unknown classification with danger sign escalates via heuristic base", () => {
  // A classification not in the table but with action wording that would be URGENT via heuristic,
  // and a danger sign in the case → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("WEIRD LUNG THING", "needs antibiotics maybe", "chest indrawing and unable to wake since morning", []),
    "EMERGENCY",
  );
  // Same case without danger sign → falls back to heuristic (URGENT due to DISPOSITION_RE matching "antibiotics").
  assert.equal(
    finalizeSeverityV2("WEIRD LUNG THING", "needs antibiotics maybe", "chest indrawing, alert, drinking well", []),
    "URGENT",
  );
});

test("finalizeSeverityV2: table EMERGENCY + danger sign → EMERGENCY (no downgrade, escalation is idempotent)", () => {
  // SEVERE PNEUMONIA is EMERGENCY in table. Danger sign "lethargic" is present.
  // Escalation check fires first → EMERGENCY. Downgrade check never fires.
  assert.equal(
    finalizeSeverityV2("SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "refer urgently", "chest indrawing, breathing fast, now lethargic and drowsy", ["lethargic"]),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: mhGAP table entries — PSYCHOSIS escalation, EPILEPSY passthrough", () => {
  // PSYCHOSIS is URGENT in the table. Self-harm language escalates → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("PSYCHOSIS", "start antipsychotic, consult", "hearing voices, says he wants to kill himself", []),
    "EMERGENCY",
  );
  // EPILEPSY is URGENT in the table. No danger sign → stays URGENT.
  // NOTE: "seizure" IS in DANGER_RE, so the case text must avoid it to test the passthrough.
  assert.equal(
    finalizeSeverityV2("EPILEPSY", "start anti-seizure medicine", "three episodes of jerking with loss of awareness, normal in between", []),
    "URGENT",
  );
  // EPILEPSY with a danger sign → EMERGENCY.
  assert.equal(
    finalizeSeverityV2("EPILEPSY", "start anti-seizure medicine", "seizures, now unconscious and not breathing", []),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: MALARIA (URGENT) stays URGENT without danger sign", () => {
  // MALARIA is YELLOW → URGENT in the table.
  assert.equal(
    finalizeSeverityV2("MALARIA", "give artemether-lumefantrine", "fever for 4 days, headache, no danger signs", []),
    "URGENT",
  );
});

test("finalizeSeverityV2: SELF-HARM classification already EMERGENCY — downgrade doesn't fire", () => {
  // SELF-HARM / SUICIDE is EMERGENCY in the table. No pneumonia sign → downgrade guard
  // doesn't apply (the guard specifically checks for pneumonia signs).
  assert.equal(
    finalizeSeverityV2("SELF-HARM / SUICIDE", "refer urgently to mental health", "took an overdose, feeling suicidal", []),
    "EMERGENCY",
  );
});

test("finalizeSeverityV2: danger sign in caseText AND redFlags — handled once", () => {
  // Danger sign appears in both — still escalates correctly to EMERGENCY.
  assert.equal(
    finalizeSeverityV2("PNEUMONIA", "give oral amoxicillin", "chest indrawing, child is floppy", ["floppy", "lethargic"]),
    "EMERGENCY",
  );
});
