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

/** One weight/age band and its dose. Both strings are verbatim substrings of data/rag/dose-tables.txt
 *  (the clean PDF-text-layer source) — enforced by the dose-safety gate. */
export interface DoseBand {
  band: string; // e.g. "12 months up to 3 years (10 - <14 kg)"
  dose: string; // e.g. "2 tablets or 10 ml"
}

/** A grounded medicine. Real per-band amounts now ship in `bands` (sourced from the clean WHO dosing
 *  tables, never fabricated). `strength`/`frequency` are verbatim. `dose` is the legacy "By weight band"
 *  fallback used only when a drug has no encoded band table. */
export interface TableMedicine {
  name: string;
  strength?: string; // e.g. "250 mg tablet or 250 mg per 5 ml syrup" (verbatim)
  frequency?: string; // verbatim, e.g. "give two times daily for 5 days"
  bands?: DoseBand[]; // per-weight-band amounts (the real numbers)
  dose?: string; // legacy fallback when no `bands` (e.g. "By weight band")
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
  /** What to assess at the follow-up visit (not just the date) — verbatim WHO follow-up instruction. */
  follow_up_detail?: GroundedLine | null;
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
// Universal "counsel the mother" home care for any child treated at home (IMCI Plan-A / counsel, p.23).
const HOME_FLUID_FEED: GroundedLine[] = [
  { text: "Give Extra Fluid", page: 23 },
  { text: "Continue Feeding", page: 23 },
];
// Symptomatic antipyretic / analgesic (IMCI p.17). Surfaced on febrile + ear-pain classes.
const PARACETAMOL: GroundedLine = { text: "Give paracetamol every 6 hours until high fever or ear pain is gone", page: 17 };
// Universal follow-up instruction (IMCI follow-up section, p.32): re-screen for danger signs.
const FU_DANGER: GroundedLine = { text: "Check the child for general danger signs", page: 32 };
// Pre-referral treatment for a child being referred URGENTLY (IMCI p.21 intramuscular antibiotics, p.8).
const IM_ANTIBIOTIC: TableMedicine = {
  name: "Ampicillin + Gentamicin (intramuscular pre-referral first dose)",
  dose: "Give Ampicillin (50 mg/kg) and Gentamicin (7.5 mg/kg)",
  page: 21,
};
const PREVENT_HYPOGLYCAEMIA: GroundedLine = { text: "Treat the child to prevent low blood sugar", page: 8 };

// ── Drug dosing (real per-band amounts; every string verbatim ⊂ data/rag/dose-tables.txt) ───────────
const AMOXICILLIN: TableMedicine = {
  name: "Amoxicillin",
  strength: "250 mg tablet or 250 mg per 5 ml syrup",
  frequency: "give two times daily for 5 days",
  bands: [
    { band: "2 months up to 12 months (4 - <10 kg)", dose: "1 tablet or 5 ml" },
    { band: "12 months up to 3 years (10 - <14 kg)", dose: "2 tablets or 10 ml" },
    { band: "3 years up to 5 years (14-19 kg)", dose: "3 tablets or 15 ml" },
  ],
  page: 16,
};
const CIPROFLOXACIN: TableMedicine = {
  name: "Ciprofloxacin",
  strength: "250 mg or 500 mg tablet",
  frequency: "give 15 mg/kg two times daily for 3 days",
  bands: [
    { band: "Less than 6 months", dose: "1/2 of a 250 mg tablet or 1/4 of a 500 mg tablet" },
    { band: "6 months up to 5 years", dose: "1 of a 250 mg tablet or 1/2 of a 500 mg tablet" },
  ],
  page: 16,
};
const ZINC: TableMedicine = {
  name: "Zinc",
  strength: "20 mg tablet",
  bands: [
    { band: "2 months up to 6 months", dose: "1/2 tablet daily for 14 days" },
    { band: "6 months or more", dose: "1 tablet daily for 14 days" },
  ],
  page: 23,
};
const ARTEMETHER_LUMEFANTRINE: TableMedicine = {
  name: "Artemether-lumefantrine",
  strength: "20 mg artemether and 120 mg lumefantrine tablet",
  frequency: "give two times daily for 3 days",
  bands: [
    { band: "5 - <10 kg (2 months up to 12 months)", dose: "1 tablet per dose" },
    { band: "10 - <14 kg (12 months up to 3 years)", dose: "1 tablet per dose" },
    { band: "14 - <19 kg (3 years up to 5 years)", dose: "2 tablets per dose" },
  ],
  page: 17,
};
const ORS: TableMedicine = {
  name: "ORS (oral rehydration salts)",
  frequency: "give recommended amount of ORS over 4-hour period",
  bands: [
    { band: "< 6 kg (up to 4 months)", dose: "200 - 450 ml" },
    { band: "6 - <10 kg (4 months up to 12 months)", dose: "450 - 800 ml" },
    { band: "10 - <12 kg (12 months up to 2 years)", dose: "800 - 960 ml" },
    { band: "12 - 19 kg (2 years up to 5 years)", dose: "960 - 1600 ml" },
  ],
  page: 23,
};
const IRON: TableMedicine = {
  name: "Iron",
  strength: "ferrous sulfate + folate tablet (60 mg elemental iron) or ferrous fumarate syrup (100 mg per 5 ml)",
  frequency: "give one dose daily for 14 days",
  bands: [
    { band: "2 months up to 4 months (4 - <6 kg)", dose: "1.00 ml syrup" },
    { band: "4 months up to 12 months (6 - <10 kg)", dose: "1.25 ml syrup" },
    { band: "12 months up to 3 years (10 - <14 kg)", dose: "1/2 tablet or 2.00 ml" },
    { band: "3 years up to 5 years (14 - 19 kg)", dose: "1/2 tablet or 2.5 ml" },
  ],
  page: 18,
};

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
    medicines: [IM_ANTIBIOTIC],
    supportive: [PREVENT_HYPOGLYCAEMIA],
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
    medicines: [AMOXICILLIN],
    supportive: [PARACETAMOL],
    home_care: [{ text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 }, ...HOME_FLUID_FEED],
    return_now: [...RETURN_ANY, ...RETURN_COUGH],
    follow_up: { text: "Follow-up in 3 days", page: 6 },
    follow_up_detail: { text: "Assess the child for cough or difficult breathing", page: 32 },
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
    home_care: [{ text: "Soothe the throat and relieve the cough with a safe remedy", page: 6 }, ...HOME_FLUID_FEED],
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
    medicines: [IM_ANTIBIOTIC],
    supportive: [
      { text: "Give first dose of artesunate or quinine for severe malaria", page: 8 },
      { text: "Give first dose of an appropriate antibiotic", page: 8 },
      PREVENT_HYPOGLYCAEMIA,
    ],
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
    medicines: [ARTEMETHER_LUMEFANTRINE],
    supportive: [
      PARACETAMOL,
      { text: "Give the first dose of artemether-lumefantrine in the clinic and observe for one hour", page: 17 },
      { text: "Give second dose at home after 8 hours", page: 17 },
    ],
    home_care: [...HOME_FLUID_FEED],
    return_now: [...RETURN_ANY, { text: "If fever is present every day for more than 7 days, refer for assessment", page: 8 }],
    follow_up: { text: "Follow-up in 3 days if fever persists", page: 8 },
    follow_up_detail: FU_DANGER,
    referral: null,
  },
  "FEVER: NO MALARIA": {
    protocol: "IMCI",
    colour: "GREEN",
    severity: "ROUTINE",
    action: { text: "Give appropriate antibiotic treatment for an identified bacterial cause of fever", page: 8 },
    citation: { text: "Give appropriate antibiotic treatment for an identified bacterial cause of fever", page: 8 },
    medicines: [],
    supportive: [PARACETAMOL],
    home_care: [...HOME_FLUID_FEED],
    return_now: [...RETURN_ANY, { text: "If fever is present every day for more than 7 days, refer for assessment", page: 8 }],
    follow_up: { text: "Follow-up in 3 days if fever persists", page: 8 },
    follow_up_detail: FU_DANGER,
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
    supportive: [
      { text: "Start IV fluid", page: 24 },
      { text: "Refer URGENTLY to hospital with mother giving frequent sips of ORS on the way", page: 7 },
    ],
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
    medicines: [ORS, ZINC],
    supportive: [],
    home_care: [...HOME_FLUID_FEED],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: { text: "Follow-up in 5 days if not improving", page: 7 },
    follow_up_detail: FU_DANGER,
    referral: null,
  },
  "NO DEHYDRATION": {
    protocol: "IMCI",
    colour: "GREEN",
    severity: "ROUTINE",
    action: { text: "Give fluid, zinc supplements, and food to treat diarrhoea at home (Plan A)", page: 7 },
    citation: { text: "Give fluid, zinc supplements, and food to treat diarrhoea at home (Plan A)", page: 7 },
    medicines: [ZINC],
    supportive: [],
    home_care: [...HOME_FLUID_FEED],
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
    medicines: [CIPROFLOXACIN],
    supportive: [],
    home_care: [...HOME_FLUID_FEED],
    return_now: [...RETURN_ANY, ...RETURN_DIARRHOEA],
    follow_up: { text: "Follow-up in 3 days", page: 7 },
    follow_up_detail: FU_DANGER,
    referral: null,
  },

  // ── IMCI: ear ────────────────────────────────────────────────────────────────────
  MASTOIDITIS: {
    protocol: "IMCI",
    colour: "PINK",
    severity: "EMERGENCY",
    action: { text: "Give first dose of an appropriate antibiotic", page: 9 },
    citation: { text: "MASTOIDITIS Give first dose of an appropriate antibiotic", page: 9 },
    medicines: [IM_ANTIBIOTIC],
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
    medicines: [AMOXICILLIN],
    supportive: [PARACETAMOL, { text: "Dry the ear by wicking", page: 9 }],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 5 days", page: 9 },
    follow_up_detail: FU_DANGER,
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
    action: { text: "Refer URGENTLY to hospital", page: 6 },
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
    medicines: [IRON, { name: "Mebendazole", frequency: "500 mg mebendazole as a single dose", page: 20 }],
    supportive: [
      { text: "Give mebendazole if child is 1 year or older and has not had a dose in the previous 6 months", page: 11 },
    ],
    home_care: [],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 14 days", page: 11 },
    follow_up_detail: FU_DANGER,
    referral: null,
  },

  // ── IMCI: acute malnutrition ─────────────────────────────────────────────────────
  "SEVERE ACUTE MALNUTRITION": {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give ready-to-use therapeutic food", page: 10 },
    citation: { text: "Give ready-to-use therapeutic food", page: 10 },
    medicines: [AMOXICILLIN],
    supportive: [
      { text: "Give Ready-to-Use Therapeutic Food", page: 10 },
      { text: "Assess for possible TB infection", page: 10 },
    ],
    home_care: [...HOME_FLUID_FEED],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 7 days", page: 10 },
    follow_up_detail: FU_DANGER,
    // Refer urgently if the SAM is COMPLICATED (oedema of both feet, a medical complication, or fails
    // the appetite test). Surfaced so the worker escalates the complicated path.
    referral: { text: "Refer URGENTLY to hospital", page: 10 },
  },
  "MODERATE ACUTE MALNUTRITION": {
    protocol: "IMCI",
    colour: "YELLOW",
    severity: "URGENT",
    action: { text: "Give ready-to-use therapeutic food", page: 10 },
    citation: { text: "Give ready-to-use therapeutic food", page: 10 },
    medicines: [],
    supportive: [{ text: "Assess for possible TB infection", page: 10 }],
    home_care: [...HOME_FLUID_FEED],
    return_now: RETURN_ANY,
    follow_up: { text: "Follow-up in 30 days", page: 10 },
    follow_up_detail: FU_DANGER,
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
    supportive: [
      { text: "Remove access to means of self-harm", page: 145 },
      { text: "Offer and activate psychosocial support", page: 145 },
    ],
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
  { test: /diarrh|loose stool|watery stool|\bstools?\b|\bmotions?\b|dehydrat|skin pinch|sunken|\bORS\b|runny poo|\bblood\b|bloody|\bdysentery\b/i, classes: ["SEVERE DEHYDRATION", "SOME DEHYDRATION", "NO DEHYDRATION", "DYSENTERY"] },
  { test: /\bear\b|mastoid|behind the ear/i, classes: ["MASTOIDITIS", "ACUTE EAR INFECTION", "CHRONIC EAR INFECTION"] },
  { test: /pallor|\bpale\b|an[ae]mia/i, classes: ["SEVERE ANAEMIA", "ANAEMIA"] },
  // Malnutrition needs an anthropometric/oedema sign (wasting, low MUAC, swollen feet) — NOT just poor
  // appetite ("not eating" collides with depression and any acute illness, so it is deliberately excluded).
  { test: /malnutrition|wasted|wasting|oedema|edema|\bthin\b|\bMUAC\b|arm[- ]?circumference|swelling of (?:both )?feet|swollen feet|feet (?:are )?swollen/i, classes: ["SEVERE ACUTE MALNUTRITION", "MODERATE ACUTE MALNUTRITION"] },
  { test: /mood|depress|\bsad\b|loss of interest|no interest|hopeless|worthless|\bvoices?\b|hearing (?:a )?voice|hallucin|delusion|psychos|paranoi|spying|disorganis|withdrawn|tearful|insomnia|can'?t sleep|not sleeping|hasn'?t slept|sleepless|trouble sleeping|convuls|seizure|epilep|\bfits?\b|jerk\w*|loss of awareness|loss of consciousness|staring spell|absence seizure|suicid|self-?\s?harm|harm (?:him|her|them)self|kill (?:him|her|them)self|substance|alcohol|withdrawal|overdose|dementia|memory loss/i, classes: ["DEPRESSION", "PSYCHOSIS", "EPILEPSY", "SELF-HARM / SUICIDE", "BIPOLAR DISORDER", "DEMENTIA", "DISORDERS DUE TO SUBSTANCE USE"] },
  // General danger signs with no other main symptom still route to the severe IMCI classes (so a pure
  // danger-sign emergency escalates instead of abstaining). The danger-sign gate confirms the severity.
  { test: /not able to (?:drink|feed|breastfeed)|unable to (?:drink|feed|breastfeed)|cannot (?:drink|feed)|won'?t (?:drink|feed|breastfeed)|vomit(?:s|ing)? everything|unconscious|unrousable|lethargic|floppy|stridor|grunting|cyanos|stopped breathing|not breathing/i, classes: ["SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "VERY SEVERE FEBRILE DISEASE", "SEVERE DEHYDRATION"] },
];

/**
 * The classifications the model may choose from for THIS case: the union of the detected main symptoms'
 * classes (+ UNKNOWN). If no symptom keyword matches, return the FULL enum (don't over-constrain — the
 * retrieval abstain gate + the model's UNKNOWN handle a non-clinical case). This is the per-request enum
 * passed to the extract grammar so the model classifies within the right symptom, not across all 25.
 */
/** Adult cardiac chest pain: out of this tool's scope (paediatric IMCI + mhGAP). Detected so it abstains
 *  rather than being mis-routed to a paediatric respiratory class by the word "chest". */
function isAdultCardiac(caseText: string): boolean {
  const t = caseText.toLowerCase();
  const chestPain = /chest pain|crushing (?:chest|central)|pain in (?:the |his |her )?chest|chest tightness|tightness in (?:the |his |her )?chest|pressure in (?:the |his |her )?chest/.test(t);
  const cardiacRadiation = /left arm|down (?:the|his|her) arm|into (?:the|his|her) (?:arm|jaw)|radiat\w*|spreading to|to (?:the|his|her) jaw|crushing/.test(t);
  const isChild = /\bmonths? old\b|\binfant\b|\bbaby\b|\bnewborn\b|\btoddler\b|\bchild\b|\b(?:[0-9]|1[0-5])[- ]?(?:year|yr)s?[- ]?old\b/.test(t);
  return chestPain && cardiacRadiation && !isChild;
}

export function allowedClassesFor(caseText: string): string[] {
  // Out-of-scope guard: this tool is paediatric IMCI + mental-health mhGAP, NOT adult physical
  // medicine. An adult cardiac presentation (chest pain that is crushing or radiates to the arm/jaw,
  // in someone who is not a child) must ABSTAIN, not be pulled into a paediatric respiratory class by
  // the bare word "chest". A child's "chest indrawing" has no "chest pain"/radiation, so it is untouched.
  if (isAdultCardiac(caseText)) return ["UNKNOWN"];

  const set = new Set<string>();
  for (const { test, classes } of SYMPTOM_CLASSES) if (test.test(caseText)) classes.forEach((c) => set.add(c));

  // Negated-fever guard: "no fever" / "afebrile" must NOT surface the fever classes. Otherwise a
  // seizure case that mentions "no fever" gets MALARIA / VERY SEVERE FEBRILE offered and the model
  // picks one (the epilepsy→malaria misroute). Only suppress when there is no positive fever sign.
  const noFever = /\bno fever\b|\bafebrile\b|\bwithout (?:a )?fever\b|\bno temperature\b/i.test(caseText);
  const positiveFever = /\bfebrile\b|\bhot\b|\bmalaria\b|stiff neck|temperature (?:of |is |reading )?\d|\b(?:high|spiking|3[89]|40)\b[^.]{0,12}fever|fever[^.]{0,12}\b(?:3[89]|40|high)\b/i.test(caseText);
  if (noFever && !positiveFever) {
    for (const c of ["VERY SEVERE FEBRILE DISEASE", "MALARIA", "FEVER: NO MALARIA"]) set.delete(c);
  }

  // Self-harm gate: SELF-HARM / SUICIDE is only a real option when self-harm/suicide language is
  // genuinely present (non-negated). "no talk of self-harm" / "no thoughts of self-harm" must NOT
  // offer it, or the model over-picks SELF-HARM for a psychosis or depression case.
  if (set.has("SELF-HARM / SUICIDE") && !hasSelfHarmLanguage(caseText)) set.delete("SELF-HARM / SUICIDE");

  // No recognised IMCI/mhGAP main symptom or danger sign → force UNKNOWN (abstain). This stops an
  // out-of-scope case (e.g. an adult abdominal/OB complaint) from being free-classified across all 25
  // classes and hallucinating a wrong emergency. The model can only confirm "no match → escalate".
  if (set.size === 0) return ["UNKNOWN"];
  set.add("UNKNOWN");
  return [...set];
}

/**
 * Is genuine, non-negated self-harm/suicide language present? Used to gate the SELF-HARM / SUICIDE
 * class so a psychosis or depression case that explicitly states "no thoughts of self-harm" is not
 * offered (and mis-picked as) self-harm. Catches both the clinical terms and lay phrasings.
 */
export function hasSelfHarmLanguage(caseText: string): boolean {
  const t = caseText.toLowerCase();
  const term = /(suicid\w*|self-?\s?harm|harm (?:him|her|them)self|hurt (?:him|her|them)self|kill (?:him|her|them)self|end (?:his|her|their|its|it all|it)\b.{0,6}life|ending it|not worth living|isn'?t worth living|no longer wants? to live|wants? to die|better off dead)/g;
  for (const m of t.matchAll(term)) {
    const idx = m.index ?? 0;
    const boundary = Math.max(t.lastIndexOf(",", idx - 1), t.lastIndexOf(";", idx - 1), t.lastIndexOf(" but ", idx - 1));
    const clause = t.slice(boundary < 0 ? 0 : boundary, idx);
    if (/\b(no|not|without|denies|denied|never|no talk of|no thoughts? of)\b/.test(clause)) continue;
    return true;
  }
  return false;
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
  if (isDehydration && hasBloodInStool(caseText)) return "DYSENTERY";
  if (norm === "SEVERE DEHYDRATION" && !dangerSignPresent &&
      !/very (?:slow|sunken)|unconscious|lethargic|not able to drink|unable to drink|skin pinch.{0,15}very/i.test(caseText)) {
    return "SOME DEHYDRATION";
  }
  return classification;
}

/**
 * Deterministic WHO ear rule: a tender/boggy swelling behind the ear (often pushing the ear forward)
 * is MASTOIDITIS and must be referred, regardless of an accompanying fever. Without this, the fever
 * pulls the 1.7B model to a febrile class (the mastoiditis→very-severe-febrile misroute). "An ear
 * problem stays an ear problem even with fever." Wins over whatever class the model picked.
 */
export function reconcileEar(classification: string, caseText: string): string {
  const t = caseText.toLowerCase();
  const behindEar = /behind (?:the )?(?:right |left )?ear|over the mastoid|mastoid (?:area|process|region)/.test(t);
  const swelling = /(swelling|swollen|boggy|lump|bulg|tender|abscess)/.test(t);
  const pushingEar = /ear (?:is )?(?:being )?push(?:ed|ing)? (?:forward|out|down)|push(?:ed|ing)? (?:the )?ear (?:forward|out)/.test(t);
  const mastoid = /\bmastoid/.test(t) || (behindEar && swelling) || pushingEar;
  return mastoid ? "MASTOIDITIS" : classification;
}

/**
 * Deterministic blood-in-stool detector. Blood in the stool is an unambiguous WHO red flag: bloody
 * diarrhoea is DYSENTERY and needs an antibiotic, never a "no dehydration / nothing" disposition. The
 * 1.7B model is unreliable here — it misses blood on terse phrasings ("blood and mucus", "stools with
 * blood") and can be talked out of it by an injected instruction. So we pin it: any blood term co-
 * occurring with a stool/diarrhoea context (or the word "dysentery") forces DYSENTERY across every path,
 * including the model-UNKNOWN abstain branch. Erring toward DYSENTERY on blood+stool is the clinically
 * conservative direction (antibiotic + assessment), which is the safe failure mode for a triage tool.
 */
export function hasBloodInStool(caseText: string): boolean {
  const t = caseText.toLowerCase();
  if (/\bdysentery\b/.test(t)) return true;
  // Negation guard: "no blood", "no visible blood", "without (any) blood", "blood-free" must NOT trigger.
  // Kept tight (adjective-only gap) so "no danger signs, blood in stool" is not falsely negated.
  if (/\bno (?:visible |obvious |fresh |any )?blood|without (?:any )?blood|blood[- ]free/.test(t)) return false;
  const blood = /\bblood\b|\bbloody\b|blood-?stained|blood-?streaked/.test(t);
  const stoolContext = /diarrh|\bstools?\b|\bmotions?\b|\bloose\b|watery|\bpoo\b|mucus/.test(t);
  return blood && stoolContext;
}

/**
 * Deterministic, class-DEFINING rationale for the card's "Why" line on encoded classes. The design is
 * "the table is truth, the model only parses" — so the displayed reasoning must come from the final
 * classification, NOT the model's free text. The model's prose is stale after a deterministic reconcile
 * (it reasoned toward the class it first picked) and can be poisoned by a prompt-injection. Each line
 * states the WHO rule that DEFINES the class (true for every case of that class), so it can never
 * contradict the card's classification, severity, action, or dosing. Unencoded classes keep the model's
 * sentence (the legacy RAG fallback path). Generic fallback covers any class not explicitly mapped.
 */
const CLASS_REASONING: Record<string, string> = {
  "SEVERE PNEUMONIA OR VERY SEVERE DISEASE": "Cough or difficult breathing with a general danger sign (or chest indrawing/stridor) → severe; refer urgently.",
  "PNEUMONIA": "Fast breathing for age with no general danger sign → pneumonia; treat with oral amoxicillin.",
  "COUGH OR COLD": "Cough with no fast breathing, no chest indrawing, and no danger sign → no pneumonia; home care, no antibiotic.",
  "VERY SEVERE FEBRILE DISEASE": "Fever with a general danger sign or stiff neck → very severe febrile disease; refer urgently.",
  "MALARIA": "Fever with malaria risk and no confirmatory test (or a positive test) → WHO no-test rule: treat as malaria.",
  "FEVER: NO MALARIA": "Fever with a negative malaria test and no malaria risk → not malaria; no antimalarial.",
  "SEVERE DEHYDRATION": "Diarrhoea with a danger sign (lethargic/unconscious, very sunken eyes, or skin pinch very slow) → severe; Plan C and refer.",
  "SOME DEHYDRATION": "Two or more of restless/irritable, sunken eyes, drinks eagerly, slow skin pinch → some dehydration; Plan B (ORS) and zinc.",
  "NO DEHYDRATION": "Diarrhoea without enough signs for some or severe dehydration → no dehydration; Plan A home fluids and zinc.",
  "DYSENTERY": "Blood in the stool → WHO classifies bloody diarrhoea as dysentery, which needs an antibiotic, not fluids alone.",
  "MASTOIDITIS": "Tender swelling behind the ear → mastoiditis; refer urgently (an ear problem stays an ear problem even with fever).",
  "ACUTE EAR INFECTION": "Ear pain or discharge for under 14 days → acute ear infection; oral amoxicillin.",
  "CHRONIC EAR INFECTION": "Ear discharge for 14 days or more → chronic ear infection; keep the ear dry by wicking.",
  "SEVERE ANAEMIA": "Severe palmar pallor → severe anaemia; refer urgently.",
  "ANAEMIA": "Some palmar pallor → anaemia; give iron and follow up.",
  "SEVERE ACUTE MALNUTRITION": "Oedema of both feet or severe wasting (MUAC/weight-for-height below the severe cut-off) → severe acute malnutrition; refer/treat per protocol.",
  "MODERATE ACUTE MALNUTRITION": "Wasting or low MUAC above the severe cut-off → moderate acute malnutrition; feed and follow up.",
  "DEPRESSION": "Persistent low mood or loss of interest for two weeks or more, without imminent self-harm → depression; psychoeducation and follow-up.",
  "PSYCHOSIS": "Delusions, hallucinations, or disorganised behaviour → psychosis; start an antipsychotic and consult/refer.",
  "EPILEPSY": "Recurrent unprovoked seizures with normal recovery in between → epilepsy; start an anti-seizure medicine.",
  "SELF-HARM / SUICIDE": "Thoughts, a plan, or an act of self-harm → do not leave the person alone; remove access to means and consult urgently.",
};

export function deterministicReasoning(classification: string, entry: ProtocolEntry): string {
  const norm = normalizeClassification(classification);
  return (
    CLASS_REASONING[norm] ??
    `Classified as ${norm} under WHO ${entry.protocol}; severity is set by the IMCI colour band and the danger-sign gate, not by the model.`
  );
}

/** The grounded urgent-referral line to surface when a case is escalated to EMERGENCY but its table entry
 *  has no referral (e.g. the model picked PNEUMONIA yet a general danger sign forced EMERGENCY). IMCI
 *  refers to hospital; mhGAP consults a specialist — each verbatim at its page. */
export function emergencyReferral(protocol: "IMCI" | "mhGAP"): GroundedLine {
  return protocol === "mhGAP" ? { text: "CONSULT A SPECIALIST", page: 34 } : REFER_URGENT;
}
