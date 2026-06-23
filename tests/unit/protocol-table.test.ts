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
import { PROTOCOL_TABLE, CLASSIFICATION_ENUM, reconcileMalaria, reconcileDiarrhoea, reconcileEar, allowedClassesFor, hasSelfHarmLanguage, type GroundedLine } from "../../src/triage/protocol-table.js";

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
