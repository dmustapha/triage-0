// File: src/triage/protocol-table.ts
// THE frozen WHO decision table — the heart of the accuracy redesign (Tier B).
//
// WHY THIS EXISTS. IMCI/mhGAP are not free text; they are decision tables: a set of signs maps (first
// match, severe→mild) to a fixed classification, and each classification has ONE fixed treatment block
// (drug + weight-band dose + counsel + return-signs + follow-up + colour). The old pipeline let the
// model's free-text classification drive retrieval and let RAG *pick* the answer — so a vague class
// re-aimed every retrieval and surfaced the wrong (or no) medicine, a positional citation fragment, and
// age-wrong advice. Here the model only PARSES the case into one enum classification; this table then
// deterministically supplies severity + the whole management plan; RAG is demoted to grounding/citation.
//
// THE DOSE-SAFETY GATE (non-negotiable). Every string below is a VERBATIM substring of a real ingested
// WHO chunk at the cited page. `tests/unit/protocol-table.test.ts` re-verifies this against the same
// citation-map the runtime reads — a hand-typed or paraphrased dose has no source chunk and FAILS the
// build. Doses are never a fabricated number: `dose` renders as "By weight band" and the real per-band
// figures live on the cited dosing page (the chart the worker is pointed to). Where a WHO line was
// OCR-cipher-corrupted (e.g. the p.8 paracetamol line), it is omitted rather than shipped — never guessed.
//
// COVERAGE IS PARTIAL BY DESIGN. A classification absent from this table (e.g. malnutrition) falls back
// to the previous RAG-assembled plan + heuristic severity (see triage.ts / severity.ts). Encoded classes
// take the deterministic path; nothing half-verified ships.
import type { Severity } from "./schema.js";

/** A single grounded line: verbatim text + the WHO page it is a substring of. */
export interface GroundedLine {
  text: string;
  page: number;
}

/** A grounded medicine. `dose` is weight-band guidance ("By weight band"), NEVER a fabricated amount —
 *  the real per-band figures are on the cited dosing page. frequency/duration are verbatim when present. */
export interface TableMedicine {
  name: string;
  dose?: string; // always "By weight band" when a banded dosing page exists; else omitted
  frequency?: string; // verbatim, e.g. "Give two times daily for 5 days"
  page: number; // the dosing/treatment page that grounds this drug
}

export interface ProtocolEntry {
  protocol: "IMCI" | "mhGAP";
  /** IMCI triage colour; null for mhGAP (no colour band — severity is set explicitly). */
  colour: "PINK" | "YELLOW" | "GREEN" | null;
  /** Severity derived from the colour band (Pink→EMERGENCY, Yellow→URGENT, Green→ROUTINE) or, for mhGAP,
   *  set explicitly. The danger-sign invariant in severity.ts can still escalate this to EMERGENCY. */
  severity: Severity;
  /** Headline disposition shown on the card — a verbatim treatment line from the classification's page. */
  action: GroundedLine;
  /** The card's protocol_citation: the classification's own WHO page + a verbatim section anchor. */
  citation: GroundedLine;
  medicines: TableMedicine[];
  supportive: GroundedLine[];
  home_care: GroundedLine[];
  return_now: GroundedLine[];
  follow_up: GroundedLine | null;
  referral: GroundedLine | null;
  /** A PINK class the model over-names from a pure pneumonia-sign presentation (chest indrawing / fast
   *  breathing) with NO general danger sign is, under the 2014 IMCI merge, the home-treatment sibling.
   *  When the danger-sign gate downgrades severity below EMERGENCY, routing switches to this class so the
   *  plan matches the disposition (oral amoxicillin, not refer). Only set on SEVERE PNEUMONIA. */
  downgradeTo?: string;
}

const IMCI_DOC = "WHO IMCI Chart Booklet (2014)";
const MHGAP_DOC = "WHO mhGAP Intervention Guide v2.0";

/** Document title for a protocol (used to render the citation `doc`). */
export function docFor(protocol: "IMCI" | "mhGAP"): string {
  return protocol === "mhGAP" ? MHGAP_DOC : IMCI_DOC;
}

// ── Reusable verbatim lines (each grounded once, reused across classes) ───────────────
// Universal IMCI "return immediately" signs (WHO chart booklet p.43).
const RETURN_ANY: GroundedLine[] = [
  { text: "Not able to drink or breastfeed", page: 43 },
  { text: "Becomes sicker", page: 43 },
  { text: "Develops a fever", page: 43 },
];
// Symptom-specific return signs (also p.43).
const RETURN_COUGH: GroundedLine[] = [
  { text: "Fast breathing", page: 43 },
  { text: "Difficult breathing", page: 43 },
];
const RETURN_DIARRHOEA: GroundedLine[] = [
  { text: "Blood in stool", page: 43 },
  { text: "Drinking poorly", page: 43 },
];
// IMCI urgent referral (verbatim on p.6; reused as the emergency disposition for any escalated case).
const REFER_URGENT: GroundedLine = { text: "Refer URGENTLY to hospital", page: 6 };

/**
 * THE TABLE. Keyed by the exact enum classification the model is constrained to emit (schema.ts).
 * Severity is fixed by colour; every text is verbatim at its `page`.
 */
export const PROTOCOL_TABLE: Record<string, ProtocolEntry> = {
  // ── IMCI: cough / breathing ──────────────────────────────────────────────────────
  "SEVERE PNEUMONIA OR VERY SEVERE DISEASE": {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "Give first dose of an appropriate antibiotic", page: 6 },
    citation: { text: "Give first dose of an appropriate antibiotic", page: 6 },
    medicines: [],
    supportive: [],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: null,
    referral: REFER_URGENT,
    downgradeTo: "PNEUMONIA",
  },
  PNEUMONIA: {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give oral Amoxicillin for 5 days", page: 6 },
    citation: { text: "Give oral Amoxicillin for 5 days", page: 6 },
    medicines: [{ name: "Amoxicillin", dose: "By weight band", frequency: "Give two times daily for 5 days", page: 16 }],
    supportive: [],
    home_care: [{ text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 }],
    return_now: [...RETURN_ANY, ...RETURN_COUGH],
    follow_up: { text: "Follow-up in 3 days", page: 6 },
    referral: null,
  },
  "COUGH OR COLD": {
    protocol: "IMCI",
    colour: "GREEN",
    severity: "ROUTINE",
    action: { text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 },
    citation: { text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 },
    medicines: [],
    supportive: [],
    home_care: [{ text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 }],
    return_now: [...RETURN_ANY, ...RETURN_COUGH],
    follow_up: { text: "Follow-up in 5 days if not improving", page: 6 },
    referral: null,
  },

  // ── IMCI: fever / malaria (THE failed case) ──────────────────────────────────────
  "VERY SEVERE FEBRILE DISEASE": {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "Give first dose of artesunate or quinine for severe malaria", page: 8 },
    citation: { text: "Give first dose of artesunate or quinine for severe malaria", page: 8 },
    medicines: [],
    supportive: [{ text: "Give first dose of an appropriate antibiotic", page: 8 }],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: null,
    referral: REFER_URGENT,
  },
  MALARIA: {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give recommended first line oral antimalarial", page: 8 },
    citation: { text: "MALARIA Give recommended first line oral antimalarial", page: 8 },
    medicines: [{ name: "Artemether-lumefantrine", dose: "By weight band", frequency: "Give two times daily for 3 days", page: 17 }],
    supportive: [
      { text: "Give the first dose of artemether-lumefantrine in the clinic and observe for one hour", page: 17 },
      { text: "Give second dose at home after 8 hours", page: 17 },
    ],
    home_care: [],
    return_now: [...RETURN_ANY, { text: "If fever is present every day for more than 7 days, refer for assessment", page: 8 }],
    follow_up: { text: "Follow-up in 3 days if fever persists", page: 8 },
    referral: null,
  },
  "FEVER: NO MALARIA": {
    protocol: "IMCI",
    colour: "GREEN",
    severity: "ROUTINE",
    action: { text: "Give appropriate antibiotic treatment for an identified bacterial cause of fever", page: 8 },
    citation: { text: "Give appropriate antibiotic treatment for an identified bacterial cause of fever", page: 8 },
    medicines: [],
    supportive: [],
    home_care: [],
    return_now: [...RETURN_ANY, { text: "If fever is present every day for more than 7 days, refer for assessment", page: 8 }],
    follow_up: { text: "Follow-up in 3 days if fever persists", page: 8 },
    referral: null,
  },

  // ── IMCI: diarrhoea ──────────────────────────────────────────────────────────────
  "SEVERE DEHYDRATION": {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "Give fluid for severe dehydration (Plan C)", page: 7 },
    citation: { text: "Give fluid for severe dehydration (Plan C)", page: 7 },
    medicines: [],
    supportive: [],
    home_care: [],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: null,
    referral: REFER_URGENT,
  },
  "SOME DEHYDRATION": {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give fluid, zinc supplements, and food for some dehydration (Plan B)", page: 7 },
    citation: { text: "Give fluid, zinc supplements, and food for some dehydration (Plan B)", page: 7 },
    medicines: [
      { name: "ORS", page: 7 },
      { name: "Zinc", dose: "By weight band", page: 23 },
    ],
    supportive: [],
    home_care: [],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: { text: "Follow-up in 5 days if not improving", page: 7 },
    referral: null,
  },
  "NO DEHYDRATION": {
    protocol: "IMCI",
    colour: "GREEN",
    severity: "ROUTINE",
    action: { text: "Give fluid, zinc supplements, and food to treat diarrhoea at home (Plan A)", page: 7 },
    citation: { text: "Give fluid, zinc supplements, and food to treat diarrhoea at home (Plan A)", page: 7 },
    medicines: [{ name: "Zinc", dose: "By weight band", page: 23 }],
    supportive: [],
    home_care: [],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: { text: "Follow-up in 5 days if not improving", page: 7 },
    referral: null,
  },
  DYSENTERY: {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give ciprofloxacin for 3 days", page: 7 },
    citation: { text: "DYSENTERY Give ciprofloxacin for 3 days", page: 7 },
    medicines: [{ name: "Ciprofloxacin", dose: "By weight band", frequency: "Give 15mg/kg two times daily for 3 days", page: 16 }],
    supportive: [],
    home_care: [],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: { text: "Follow-up in 3 days", page: 7 },
    referral: null,
  },

  // ── IMCI: ear ────────────────────────────────────────────────────────────────────
  MASTOIDITIS: {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "Give first dose of an appropriate antibiotic", page: 9 },
    citation: { text: "MASTOIDITIS Give first dose of an appropriate antibiotic", page: 9 },
    medicines: [],
    supportive: [{ text: "Give first dose of paracetamol for pain", page: 9 }],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: null,
    referral: REFER_URGENT,
  },
  "ACUTE EAR INFECTION": {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Dry the ear by wicking", page: 9 },
    citation: { text: "ACUTE EAR INFECTION", page: 16 },
    medicines: [{ name: "Amoxicillin", dose: "By weight band", frequency: "Give two times daily for 5 days", page: 16 }],
    supportive: [{ text: "Dry the ear by wicking", page: 9 }],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 5 days", page: 9 },
    referral: null,
  },
  "CHRONIC EAR INFECTION": {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Dry the ear by wicking", page: 9 },
    citation: { text: "CHRONIC EAR INFECTION Dry the ear by wicking", page: 9 },
    medicines: [],
    supportive: [
      { text: "Dry the ear by wicking", page: 9 },
      { text: "Treat with topical quinolone eardrops for 14 days", page: 9 },
    ],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 5 days", page: 9 },
    referral: null,
  },

  // ── IMCI: anaemia ────────────────────────────────────────────────────────────────
  "SEVERE ANAEMIA": {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "SEVERE ANAEMIA", page: 11 },
    citation: { text: "SEVERE ANAEMIA", page: 11 },
    medicines: [],
    supportive: [],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: null,
    referral: REFER_URGENT,
  },
  ANAEMIA: {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give iron", page: 11 },
    citation: { text: "ANAEMIA Give iron", page: 11 },
    medicines: [
      { name: "Iron", dose: "By weight band", frequency: "Give one dose daily for 14 days", page: 18 },
      { name: "Mebendazole", page: 11 },
    ],
    supportive: [
      { text: "Give mebendazole if child is 1 year or older and has not had a dose in the previous 6 months", page: 11 },
    ],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 14 days", page: 11 },
    referral: null,
  },

  // ── mhGAP: mental, neurological, substance-use ───────────────────────────────────
  DEPRESSION: {
    protocol: "mhGAP",
    colour: null,
    severity: "URGENT",
    action: { text: "Provide psychoeducation to the person and their carers", page: 34 },
    citation: { text: "Provide psychoeducation to the person and their carers", page: 34 },
    medicines: [{ name: "Fluoxetine", frequency: "Start 10 mg daily for one week then 20 mg daily", page: 37 }],
    supportive: [
      { text: "Reduce stress and strengthen social supports", page: 34 },
      { text: "Promote functioning in daily activities", page: 34 },
    ],
    home_care: [],
    return_now: [
      { text: "If they notice these thoughts, they should not act on them, but should tell a trusted person and come back for help", page: 35 },
    ],
    follow_up: { text: "schedule a follow-up appointment", page: 21 },
    referral: { text: "CONSULT A SPECIALIST", page: 34 },
  },
  PSYCHOSIS: {
    protocol: "mhGAP",
    colour: null,
    severity: "URGENT",
    action: { text: "Always offer psychosocial interventions for the person and their carers", page: 19 },
    citation: { text: "Always offer psychosocial interventions for the person and their carers", page: 19 },
    medicines: [
      { name: "Haloperidol", frequency: "Start 1.5-3 mg daily", page: 50 },
      { name: "Risperidone", frequency: "Start 1 mg daily", page: 50 },
    ],
    supportive: [{ text: "Always offer psychosocial interventions for the person and their carers", page: 19 }],
    home_care: [],
    return_now: [],
    follow_up: { text: "schedule a follow-up appointment", page: 21 },
    referral: { text: "CONSULT A SPECIALIST", page: 34 },
  },
  EPILEPSY: {
    protocol: "mhGAP",
    colour: null,
    severity: "URGENT",
    action: { text: "Initiate antiepileptic medications", page: 73 },
    citation: { text: "Initiate antiepileptic medications", page: 73 },
    medicines: [
      { name: "Carbamazepine", frequency: "Start 200 mg daily", page: 51 },
      { name: "Sodium valproate", frequency: "Start 500 mg daily", page: 51 },
    ],
    supportive: [],
    home_care: [],
    return_now: [],
    follow_up: { text: "schedule a follow-up appointment", page: 21 },
    referral: { text: "CONSULT A SPECIALIST", page: 34 },
  },
  "SELF-HARM / SUICIDE": {
    protocol: "mhGAP",
    colour: null,
    severity: "EMERGENCY",
    action: { text: "DO NOT LEAVE THE PERSON ALONE", page: 61 },
    citation: { text: "DO NOT LEAVE THE PERSON ALONE", page: 61 },
    medicines: [],
    supportive: [],
    home_care: [],
    return_now: [],
    follow_up: null,
    referral: { text: "CONSULT A SPECIALIST", page: 34 },
  },
};

/** The exact classification strings the model may emit (enum-constrained in schema.ts), plus the
 *  fallback-only classes (in the enum so the model can pick them, routed via the legacy RAG plan), plus
 *  UNKNOWN (abstain). Order: severe→mild within each symptom, as the WHO chart reads. */
export const CLASSIFICATION_ENUM: string[] = [
  // IMCI — table-encoded
  "SEVERE PNEUMONIA OR VERY SEVERE DISEASE",
  "PNEUMONIA",
  "COUGH OR COLD",
  "VERY SEVERE FEBRILE DISEASE",
  "MALARIA",
  "FEVER: NO MALARIA",
  "SEVERE DEHYDRATION",
  "SOME DEHYDRATION",
  "NO DEHYDRATION",
  "DYSENTERY",
  "MASTOIDITIS",
  "ACUTE EAR INFECTION",
  "CHRONIC EAR INFECTION",
  "SEVERE ANAEMIA",
  "ANAEMIA",
  // IMCI — fallback (heuristic severity + legacy RAG plan)
  "SEVERE ACUTE MALNUTRITION",
  "MODERATE ACUTE MALNUTRITION",
  // mhGAP — table-encoded
  "DEPRESSION",
  "PSYCHOSIS",
  "EPILEPSY",
  "SELF-HARM / SUICIDE",
  // mhGAP — fallback
  "BIPOLAR DISORDER",
  "DEMENTIA",
  "DISORDERS DUE TO SUBSTANCE USE",
  // Abstain
  "UNKNOWN",
];

// ── Main-symptom routing (the IMCI "assess each main symptom, classify within it" structure) ─────────
// A flat 25-way classification is unreliable for a 1.7B model — it drifts ACROSS symptoms (an ear case
// lands on dehydration, a comorbid case on malnutrition). So we detect the case's main symptom(s) by
// keyword and constrain the extract enum to ONLY that symptom's classifications. The model then makes a
// 2-4 way WITHIN-symptom choice, which it handles well, and a cross-symptom error becomes impossible.
const SYMPTOM_CLASSES: { test: RegExp; classes: string[] }[] = [
  { test: /cough|breath|indrawing|stridor|wheez|pneumonia|\bchest\b|cyanos|grunt/i, classes: ["SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "PNEUMONIA", "COUGH OR COLD"] },
  { test: /fever|febrile|malaria|temperature|\bhot\b|stiff neck/i, classes: ["VERY SEVERE FEBRILE DISEASE", "MALARIA", "FEVER: NO MALARIA"] },
  { test: /diarrh|loose stool|watery stool|\bstool\b|dehydrat|skin pinch|sunken|\bORS\b|runny poo/i, classes: ["SEVERE DEHYDRATION", "SOME DEHYDRATION", "NO DEHYDRATION", "DYSENTERY"] },
  { test: /\bear\b|mastoid|behind the ear/i, classes: ["MASTOIDITIS", "ACUTE EAR INFECTION", "CHRONIC EAR INFECTION"] },
  { test: /pallor|\bpale\b|an[ae]mia/i, classes: ["SEVERE ANAEMIA", "ANAEMIA"] },
  { test: /malnutrition|wasted|wasting|oedema|edema|\bthin\b|not eating|refus\w* to eat|\bMUAC\b/i, classes: ["SEVERE ACUTE MALNUTRITION", "MODERATE ACUTE MALNUTRITION"] },
  { test: /mood|depress|\bsad\b|loss of interest|hopeless|voices|hallucin|delusion|psychos|paranoi|spying|disorganis|convuls|seizure|epilep|\bfits?\b|suicid|self-?\s?harm|harm (?:him|her|them)self|kill (?:him|her|them)self|substance|alcohol|withdrawal|overdose|dementia|memory loss/i, classes: ["DEPRESSION", "PSYCHOSIS", "EPILEPSY", "SELF-HARM / SUICIDE", "BIPOLAR DISORDER", "DEMENTIA", "DISORDERS DUE TO SUBSTANCE USE"] },
];

/**
 * The classifications the model may choose from for THIS case: the union of the detected main symptoms'
 * classes (+ UNKNOWN). If no symptom keyword matches, return the FULL enum (don't over-constrain — the
 * retrieval abstain gate + the model's UNKNOWN handle a non-clinical case). This is the per-request enum
 * passed to the extract grammar so the model classifies within the right symptom, not across all 25.
 */
export function allowedClassesFor(caseText: string): string[] {
  const set = new Set<string>();
  for (const { test, classes } of SYMPTOM_CLASSES) if (test.test(caseText)) classes.forEach((c) => set.add(c));
  if (set.size === 0) return [...CLASSIFICATION_ENUM];
  set.add("UNKNOWN");
  return [...set];
}

/** Normalise a model-emitted classification to a table key (trim, collapse whitespace, upper-case). The
 *  enum constraint already pins the wording, but the belt-and-braces regex parse path in triage.ts is not
 *  enum-bound, so normalise defensively before lookup. */
export function normalizeClassification(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toUpperCase();
}

/** The frozen entry for a classification, or undefined if it is not table-encoded (→ legacy fallback). */
export function lookupProtocol(classification: string): ProtocolEntry | undefined {
  return PROTOCOL_TABLE[normalizeClassification(classification)];
}

/** Is this classification driven by the deterministic table (vs the legacy RAG-assembled fallback)? */
export function isEncoded(classification: string): boolean {
  return normalizeClassification(classification) in PROTOCOL_TABLE;
}

/**
 * Deterministic WHO no-test rule: in a malaria-risk area, an untested febrile child is treated AS malaria.
 * The model is unstable RIGHT at this boundary (greedy decoding still flips MALARIA ↔ FEVER: NO MALARIA
 * run-to-run on engine float noise), so we pin it: if the model said FEVER: NO MALARIA but the case states
 * malaria risk/area AND does NOT state a negative test or absence of risk, correct to MALARIA. The
 * negative-test guard keeps a genuinely test-negative or no-risk case as FEVER: NO MALARIA.
 */
export function reconcileMalaria(classification: string, caseText: string): string {
  if (normalizeClassification(classification) !== "FEVER: NO MALARIA") return classification;
  const t = caseText.toLowerCase();
  const malariaRisk = /malaria area|malaria[- ]?risk|high[- ]?risk|endemic|in a malaria|lives? in[^.]{0,40}malaria|travel(?:led)?[^.]{0,40}malaria/.test(t);
  const negated = /test[^.]{0,20}negative|negative[^.]{0,20}(?:test|malaria)|tested negative|no malaria risk|not a malaria area|no risk of malaria|do(?:es)? ?n.?t live[^.]{0,30}malaria|not? malaria area/.test(t);
  return malariaRisk && !negated ? "MALARIA" : classification;
}

/**
 * Deterministic WHO diarrhoea guards (the model is unstable on diarrhoea severity + misses blood):
 *  (a) Blood in the stool → DYSENTERY (WHO classifies bloody diarrhoea as dysentery — it needs an
 *      antibiotic, not just fluids). This wins over any DEHYDRATION class the model picked.
 *  (b) SEVERE DEHYDRATION (Pink, Plan C, refer) requires a general danger sign (lethargic/unconscious/
 *      not able to drink) OR very sunken eyes OR skin pinch going back VERY slowly. The model over-calls
 *      it for plain SOME-dehydration signs (sunken eyes + drinks eagerly + skin pinch slow). Without a
 *      severe marker, correct SEVERE → SOME DEHYDRATION.
 * `dangerSignPresent` is computed by the caller (severity.hasEmergencySign) to avoid a module cycle.
 */
export function reconcileDiarrhoea(classification: string, caseText: string, dangerSignPresent: boolean): string {
  const norm = normalizeClassification(classification);
  const isDehydration = norm === "SEVERE DEHYDRATION" || norm === "SOME DEHYDRATION" || norm === "NO DEHYDRATION";
  if (isDehydration && /blood in (?:the )?stool|bloody (?:stool|diarrh)|blood in (?:the )?diarrh/i.test(caseText)) return "DYSENTERY";
  if (norm === "SEVERE DEHYDRATION" && !dangerSignPresent &&
      !/very (?:slow|sunken)|unconscious|lethargic|not able to drink|unable to drink|skin pinch.{0,15}very/i.test(caseText)) {
    return "SOME DEHYDRATION";
  }
  return classification;
}

/** The grounded urgent-referral line to surface when a case is escalated to EMERGENCY but its table entry
 *  has no referral (e.g. the model picked PNEUMONIA yet a general danger sign forced EMERGENCY). IMCI
 *  refers to hospital; mhGAP consults a specialist — each verbatim at its page. */
export function emergencyReferral(protocol: "IMCI" | "mhGAP"): GroundedLine {
  return protocol === "mhGAP" ? { text: "CONSULT A SPECIALIST", page: 34 } : REFER_URGENT;
}
