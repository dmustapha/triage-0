// File: tests/unit/protocol-table.test.ts
// THE DOSE-SAFETY GATE (model-free, runs every suite). The accuracy redesign asserts WHO treatment lines
// deterministically from src/triage/protocol-table.ts, so each line — ESPECIALLY a dose — MUST be a
// verbatim substring of the real ingested WHO chunk at its cited page. A hand-typed or paraphrased dose
// has no source chunk and FAILS here, before it can ever reach a health worker. This reads the SAME
// citation-map.json the runtime store reads (data/rag/citation-map.json), so the gate and the product
// can never disagree. Self-skips if the store is not ingested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { config } from "../../src/config.js";
import { PROTOCOL_TABLE, CLASSIFICATION_ENUM, reconcileMalaria, reconcileDiarrhoea, reconcileEar, reconcileFebrile, reconcileMultiSymptom, hasPneumoniaSign, hasFeverMalariaContext, hasBilateralOedema, reconcileJaundice, reconcileSubstance, isPersistentDiarrhoea, allowedClassesFor, hasSelfHarmLanguage, type GroundedLine } from "../../src/triage/protocol-table.js";

const mapPath = config.citationMapPath;
const dosePath = new URL("../../data/rag/dose-tables.txt", import.meta.url).pathname;
const skip = existsSync(mapPath) ? false : "citation-map.json not present — run `npm run ingest` first";

type MapEntry = { protocol: string; title: string; page: number; section: string; content: string };
const CMAP: Record<string, MapEntry> = skip ? {} : JSON.parse(readFileSync(mapPath, "utf8"));
// The clean PDF-text-layer source for the per-band dosing the RAG ingest mangled (provenance in-file).
const DOSE_SRC = existsSync(dosePath) ? readFileSync(dosePath, "utf8") : "";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const DOSE_N = norm(DOSE_SRC);

/** Is `text` a verbatim (ws-normalised, case-insensitive) substring of SOME chunk at `page`? */
function groundedAtPage(text: string, page: number): boolean {
  const needle = norm(text);
  if (!needle) return false;
  return Object.values(CMAP).some((c) => c.page === page && norm(c.content).includes(needle));
}

/** Verbatim anywhere in the clean dose-tables source. */
function inDoseSrc(text: string): boolean {
  const n = norm(text);
  return n.length > 0 && DOSE_N.includes(n);
}

/** A clinical line is grounded if it is verbatim in the RAG corpus at its page OR in the clean dose source. */
function grounded(text: string, page: number): boolean {
  return groundedAtPage(text, page) || inDoseSrc(text);
}

function pageExists(page: number): boolean {
  return Object.values(CMAP).some((c) => c.page === page);
}

test("dose-safety gate: every protocol-table line is verbatim-grounded (RAG corpus or clean dose source)", { skip }, () => {
  for (const [cls, e] of Object.entries(PROTOCOL_TABLE)) {
    const proseLines: GroundedLine[] = [
      e.action,
      e.citation,
      ...e.supportive,
      ...e.home_care,
      ...e.return_now,
      ...(e.follow_up ? [e.follow_up] : []),
      ...(e.follow_up_detail ? [e.follow_up_detail] : []),
      ...(e.referral ? [e.referral] : []),
    ];
    for (const ln of proseLines) {
      assert.ok(grounded(ln.text, ln.page), `${cls}: "${ln.text}" is NOT verbatim in the corpus (p${ln.page}) or the dose source`);
    }
    for (const med of e.medicines) {
      assert.ok(pageExists(med.page), `${cls}: medicine ${med.name} cites a page (${med.page}) that exists in the corpus`);
      if (med.dose !== undefined) {
        assert.ok(grounded(med.dose, med.page), `${cls}: ${med.name} dose "${med.dose}" is not verbatim-grounded`);
      }
      if (med.strength !== undefined) {
        assert.ok(inDoseSrc(med.strength), `${cls}: ${med.name} strength "${med.strength}" not verbatim in the dose source`);
      }
      if (med.frequency !== undefined) {
        assert.ok(grounded(med.frequency, med.page), `${cls}: ${med.name} frequency "${med.frequency}" not verbatim`);
      }
      // THE DOSE-SAFETY CORE: every per-band amount must be verbatim in the clean WHO dose source —
      // band label AND amount, on the SAME source line (so the amount is tied to its band, not floating).
      for (const b of med.bands ?? []) {
        const onSameLine = DOSE_SRC.split("\n").some((line) => {
          const ln = norm(line);
          return ln.includes(norm(b.band)) && ln.includes(norm(b.dose));
        });
        assert.ok(onSameLine, `${cls}: ${med.name} band "${b.band}" → "${b.dose}" is NOT a verbatim WHO dose row`);
      }
    }
  }
});

test("management completeness: no encoded class ships a thin plan", () => {
  for (const [cls, e] of Object.entries(PROTOCOL_TABLE)) {
    const mgmt = e.medicines.length + e.supportive.length + e.home_care.length;
    if (e.severity === "EMERGENCY") {
      // A refer case MUST have a referral AND some pre-referral action (a drug, supportive care, or
      // return-now safety instructions) — never just a bare "refer".
      assert.ok(e.referral, `${cls} (EMERGENCY) must carry a referral`);
      assert.ok(
        mgmt + e.return_now.length >= 1,
        `${cls} (EMERGENCY) must carry pre-referral treatment, supportive care, or safety instructions`,
      );
    } else {
      // A treat case MUST have actionable management, a follow-up, and an escalation path — return-now
      // danger signs (IMCI) or a specialist referral (mhGAP).
      assert.ok(mgmt >= 1, `${cls} must carry a medicine, supportive care, or home care (got none)`);
      assert.ok(e.follow_up, `${cls} must carry a follow-up`);
      assert.ok(
        e.return_now.length >= 1 || e.referral,
        `${cls} must give an escalation path (return-now signs or a referral)`,
      );
    }
    // A drug-bearing class must specify the dose (real per-band amounts or a verbatim dose line), never
    // leave a medicine amount-less.
    for (const m of e.medicines) {
      const hasAmount = (m.bands && m.bands.length > 0) || !!m.dose || !!m.frequency;
      assert.ok(hasAmount, `${cls}: medicine ${m.name} must carry a dose (bands, dose, or frequency)`);
    }
  }
});

test("every table key is in CLASSIFICATION_ENUM (no orphan entries)", () => {
  const enumSet = new Set(CLASSIFICATION_ENUM);
  for (const cls of Object.keys(PROTOCOL_TABLE)) {
    assert.ok(enumSet.has(cls), `table key "${cls}" must be a member of CLASSIFICATION_ENUM`);
  }
});

test("CLASSIFICATION_ENUM includes UNKNOWN (the abstain escape hatch)", () => {
  assert.ok(CLASSIFICATION_ENUM.includes("UNKNOWN"), "the enum must offer UNKNOWN so an unfittable case can abstain");
});

test("reconcileMalaria: WHO no-test high-risk rule (deterministic, boundary-stable)", () => {
  // Malaria risk + no negative test → corrected to MALARIA.
  assert.equal(reconcileMalaria("FEVER: NO MALARIA", "3 year old, fever, lives in a malaria area, no test done"), "MALARIA");
  assert.equal(reconcileMalaria("FEVER: NO MALARIA", "child fever, high malaria risk area"), "MALARIA");
  // Explicit negative test or no risk → left as FEVER: NO MALARIA.
  assert.equal(reconcileMalaria("FEVER: NO MALARIA", "2 year old, fever, malaria test negative, has a cough"), "FEVER: NO MALARIA");
  assert.equal(reconcileMalaria("FEVER: NO MALARIA", "fever, does not live in a malaria area, no malaria risk"), "FEVER: NO MALARIA");
  // Never touches a non-fever-no-malaria classification.
  assert.equal(reconcileMalaria("MALARIA", "anything"), "MALARIA");
  assert.equal(reconcileMalaria("PNEUMONIA", "fever malaria area"), "PNEUMONIA");
});

test("reconcileDiarrhoea: blood→DYSENTERY and SEVERE-DEHYDRATION over-call guard (deterministic)", () => {
  // Blood in stool → DYSENTERY, overriding any dehydration class the model picked.
  assert.equal(reconcileDiarrhoea("SEVERE DEHYDRATION", "diarrhoea with blood in the stool, drinking", false), "DYSENTERY");
  assert.equal(reconcileDiarrhoea("NO DEHYDRATION", "bloody diarrhoea for two days", false), "DYSENTERY");
  // SEVERE DEHYDRATION without a severe marker → SOME DEHYDRATION.
  assert.equal(reconcileDiarrhoea("SEVERE DEHYDRATION", "sunken eyes, drinks eagerly, skin pinch goes back slowly", false), "SOME DEHYDRATION");
  // Genuine severe: danger sign present → keep SEVERE.
  assert.equal(reconcileDiarrhoea("SEVERE DEHYDRATION", "lethargic, very sunken eyes, skin pinch very slow", true), "SEVERE DEHYDRATION");
  // "very slow" marker keeps SEVERE even without a flagged danger sign.
  assert.equal(reconcileDiarrhoea("SEVERE DEHYDRATION", "eyes very sunken, skin pinch goes back very slowly", false), "SEVERE DEHYDRATION");
  // Non-dehydration classes are untouched.
  assert.equal(reconcileDiarrhoea("PNEUMONIA", "blood in the stool", false), "PNEUMONIA");
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "watery diarrhoea, no blood", false), "SOME DEHYDRATION");
  // SOME→NO downgrade (D3): all signs explicitly reassuring, no dehydration marker → NO DEHYDRATION.
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "loose stools for 2 days, alert, eyes normal, drinking well, skin pinch goes back quickly", false), "NO DEHYDRATION");
  // A genuine SOME case (D1) has dehydration markers → NOT downgraded.
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "diarrhoea, restless, sunken eyes, drinks eagerly, skin pinch goes back slowly", false), "SOME DEHYDRATION");
});

test("colour band → severity is internally consistent for IMCI entries", () => {
  const map: Record<string, string> = { PINK: "EMERGENCY", YELLOW: "URGENT", GREEN: "ROUTINE" };
  for (const [cls, e] of Object.entries(PROTOCOL_TABLE)) {
    if (e.colour) {
      assert.equal(e.severity, map[e.colour], `${cls}: colour ${e.colour} must map to severity ${map[e.colour]} (got ${e.severity})`);
    }
  }
});

test("misroute guards: epilepsy/psychosis routing, self-harm gate, ear reconcile (deterministic)", () => {
  const psy = "20 year old man, for 6 weeks convinced his food is poisoned, hearing voices commenting on him, not sleeping, no talk of self-harm.";
  assert.ok(allowedClassesFor(psy).includes("PSYCHOSIS"), "psychosis must be offered");
  assert.ok(!allowedClassesFor(psy).includes("SELF-HARM / SUICIDE"), "self-harm dropped when 'no talk of self-harm'");

  const epi = "9 year old, three episodes of sudden jerking with loss of awareness over the past month, normal in between, no fever.";
  assert.ok(allowedClassesFor(epi).includes("EPILEPSY"), "seizure synonyms must surface EPILEPSY");
  assert.ok(!allowedClassesFor(epi).includes("MALARIA"), "'no fever' must not surface fever classes");

  // self-harm language gate: lay phrasings count, negated mentions do not
  assert.ok(hasSelfHarmLanguage("says life isn't worth living and thought about ending it"));
  assert.ok(!hasSelfHarmLanguage("low mood, no thoughts of self-harm"));

  // ear reconcile: swelling behind the ear is MASTOIDITIS even with fever; otherwise untouched
  assert.equal(reconcileEar("VERY SEVERE FEBRILE DISEASE", "fever and a boggy swelling behind the right ear pushing it forward"), "MASTOIDITIS");
  assert.equal(reconcileEar("PNEUMONIA", "cough and fast breathing, no ear problem"), "PNEUMONIA");
});

test("multi-symptom precedence: respiratory/fever leads over the dehydration/ear co-class (deterministic)", () => {
  // pneumonia sign detector — positive vs negated / normal
  assert.ok(hasPneumoniaSign("cough with fast breathing 54 a minute"), "explicit rate ≥50 is a pneumonia sign");
  assert.ok(hasPneumoniaSign("pus from the ear and chest indrawing"), "chest indrawing is a pneumonia sign");
  assert.ok(hasPneumoniaSign("toux, respiration rapide à 54 par minute, tirage sous-costal"), "FR lay respiratory terms count");
  assert.ok(!hasPneumoniaSign("no chest indrawing and breathing normally"), "negated 'no chest indrawing' must NOT count (CB1)");
  assert.ok(!hasPneumoniaSign("breathing 40 a minute, alert"), "a rate below 50 is not the fast-breathing marker");

  // fever+malaria context
  assert.ok(hasFeverMalariaContext("in a malaria area, fever for 3 days no test done"));
  assert.ok(!hasFeverMalariaContext("fever, malaria test negative"), "a negative test is not the no-test rule");

  // MS1 pattern: model said SOME DEHYDRATION but a pneumonia sign is present → respiratory leads
  assert.equal(
    reconcileMultiSymptom("SOME DEHYDRATION", "cough with fast breathing 54 a minute AND watery diarrhoea, sunken eyes, drinks eagerly"),
    "SEVERE PNEUMONIA OR VERY SEVERE DISEASE", // danger-sign gate downgrades to PNEUMONIA when no danger sign
  );
  // MS5 pattern: model said ACUTE EAR INFECTION but a pneumonia sign is present → respiratory leads
  assert.equal(
    reconcileMultiSymptom("ACUTE EAR INFECTION", "cough with fast breathing 52 a minute and pus from the left ear"),
    "SEVERE PNEUMONIA OR VERY SEVERE DISEASE",
  );
  // MS2 pattern: model said SOME DEHYDRATION in a fever+malaria case (no pneumonia sign) → malaria leads
  assert.equal(
    reconcileMultiSymptom("SOME DEHYDRATION", "in a malaria area, fever 3 days no test, loose watery stools, sunken eyes"),
    "MALARIA",
  );
  // NO REGRESSION: a pure dehydration case (no pneumonia sign, no malaria) is left untouched
  assert.equal(reconcileMultiSymptom("SOME DEHYDRATION", "18-month-old, diarrhoea 2 days, restless, sunken eyes, drinks eagerly, skin pinch slow"), "SOME DEHYDRATION");
  // NO REGRESSION: CB1 (ear problem, breathing normal) stays the ear class — negated 'no chest indrawing'
  assert.equal(reconcileMultiSymptom("ACUTE EAR INFECTION", "no chest indrawing and breathing normally, pus from the ear 5 days"), "ACUTE EAR INFECTION");
  // Never re-points a non-target class (DYSENTERY / MASTOIDITIS / PNEUMONIA already primary)
  assert.equal(reconcileMultiSymptom("DYSENTERY", "blood in stool and fast breathing 55"), "DYSENTERY");
});

test("bilateral pitting oedema is detected as complicated SAM (deterministic, WHO)", () => {
  assert.ok(hasBilateralOedema("swelling of both feet that pits on pressure, very thin arms")); // RA4
  assert.ok(hasBilateralOedema("both feet are swollen and pit when pressed")); // CB3
  assert.ok(hasBilateralOedema("oedema of both feet, visible severe wasting")); // M1
  // negation + single-limb / non-oedema must NOT trip it
  assert.ok(!hasBilateralOedema("no swelling of the feet, alert and feeding"));
  assert.ok(!hasBilateralOedema("one swollen ankle after a fall"));
  assert.ok(!hasBilateralOedema("cough and fast breathing, no oedema"));
});

test("reconcileFebrile: 'very severe FEBRILE disease' without fever + respiratory danger → severe pneumonia", () => {
  // V5: no fever anywhere, lay respiratory collapse → severe cough/breathing class (still EMERGENCY+refer)
  assert.equal(
    reconcileFebrile("VERY SEVERE FEBRILE DISEASE", "5-month-old puffing and struggling, went blue round the lips, gone limp, will not take the milk"),
    "SEVERE PNEUMONIA OR VERY SEVERE DISEASE",
  );
  // genuine VSD cases carry fever / stiff neck / malaria — untouched
  assert.equal(reconcileFebrile("VERY SEVERE FEBRILE DISEASE", "high fever, bulging fontanelle, stiff neck, drowsy"), "VERY SEVERE FEBRILE DISEASE"); // RA1
  assert.equal(reconcileFebrile("VERY SEVERE FEBRILE DISEASE", "fever 2 days, stiff neck, not feeding"), "VERY SEVERE FEBRILE DISEASE"); // F2
  assert.equal(reconcileFebrile("VERY SEVERE FEBRILE DISEASE", "dengue area, high fever, bleeding gums, cold clammy"), "VERY SEVERE FEBRILE DISEASE"); // RA6
  // never touches a non-VSD class
  assert.equal(reconcileFebrile("MALARIA", "puffing and blue lips, no fever"), "MALARIA");
});


test("out-of-scope guard: adult cardiac chest pain abstains; paediatric respiratory is untouched", () => {
  const cardiac = allowedClassesFor("A 40 year old man with crushing chest pain spreading to his left arm.");
  assert.deepEqual(cardiac, ["UNKNOWN"], "adult cardiac chest pain must abstain (out of paediatric+mhGAP scope)");
  const paed = allowedClassesFor("5 year old, cough and fast breathing, chest indrawing");
  assert.ok(paed.includes("PNEUMONIA"), "a child's chest indrawing must still surface the respiratory classes");
});

test("encoded rarer conditions: persistent diarrhoea, jaundice, substance-use reconciles", () => {
  // persistent diarrhoea (>=14 days) vs acute
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "loose stools for 3 weeks, no blood", false), "PERSISTENT DIARRHOEA");
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "diarrhoea for 18 days, lethargic, very sunken eyes", true), "SEVERE PERSISTENT DIARRHOEA");
  assert.equal(reconcileDiarrhoea("SOME DEHYDRATION", "loose stools for 2 days", false), "SOME DEHYDRATION");
  assert.ok(isPersistentDiarrhoea("watery diarrhoea for over two weeks"));
  assert.ok(!isPersistentDiarrhoea("cough for 14 days")); // not a diarrhoea context
  // jaundice severity (negation-safe)
  assert.equal(reconcileJaundice("JAUNDICE", "infant, yellow eyes with yellow palms and soles"), "SEVERE JAUNDICE");
  assert.equal(reconcileJaundice("JAUNDICE", "5 day old, yellow eyes, palms and soles not yellow"), "JAUNDICE");
  // substance-use dependence pin
  assert.equal(reconcileSubstance("BIPOLAR DISORDER", "drinking alcohol heavily every day, cannot cut down, withdrawal shakes"), "DISORDERS DUE TO SUBSTANCE USE");
  assert.equal(reconcileSubstance("DEPRESSION", "low mood, mother drinks alcohol occasionally"), "DEPRESSION");
});
