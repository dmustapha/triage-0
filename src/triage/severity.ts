// File: src/triage/severity.ts
// Deterministic WHO-classification -> triage-severity mapping + the danger-sign clinical invariant.
// RECONCILE.md Phase-2: MedPsy-1.7B reliably names the CLASSIFICATION + ACTION but (a) cannot apply an
// abstract 4-way severity bucket and (b) is NON-DETERMINISTIC about severe vs home-treatment for chest
// indrawing (a strong pre-2014 prior that intermittently overrides the 2014 grounding). So severity is
// computed here, in pure auditable code the unit tests pin — not authored by the model — and an
// EMERGENCY disposition is GATED on an actual emergency sign being present in the case (the WHO rule:
// a severe/Pink classification requires a general danger sign or stridor; chest indrawing or fast
// breathing alone is the home-treatment band).
import type { Severity } from "./schema.js";
import { lookupProtocol } from "./protocol-table.js";

// "Pink": wording that means severe disease / urgent referral / a pre-referral first dose.
// The negative lookbehinds keep "NOT SEVERE" / "NON-SEVERE" out of the EMERGENCY band (they fall
// through to URGENT via the named-condition token, e.g. "non-severe pneumonia" -> URGENT).
const EMERGENCY_RE = /\b(VERY SEVERE|(?<!NOT )(?<!NON-)(?<!NON )SEVERE|GENERAL DANGER SIGN|DANGER SIGN|REFER URGENT|REFER IMMEDIAT|FIRST DOSE|PRE-?REFERRAL)\b/;
// "Green": explicit mild / no-disease classifications and home-care-only dispositions. Checked BEFORE
// the URGENT band so "NO PNEUMONIA: COUGH OR COLD" is not caught by the bare PNEUMONIA token.
// NOTE: a bare "NOT/NON SEVERE" is deliberately NOT a green marker — "NON-SEVERE PNEUMONIA" still
// needs antibiotics (URGENT/treat-&-follow-up), so it must fall through to the named-condition token
// rather than be home-care. The EMERGENCY lookbehind already keeps "NOT SEVERE" out of EMERGENCY.
const ROUTINE_RE = /\b(NO PNEUMONIA|COUGH OR COLD|NO DEHYDRATION|HOME CARE|REASSURE|SOOTHE THE THROAT|ADVISE (?:THE )?MOTHER|CONTINUE FEEDING)\b/;
// "Yellow", part 1 — a NAMED treatable condition. This MUST win over the ROUTINE counselling phrases:
// a real IMCI/mhGAP action for a treatable condition routinely contains "advise the mother" /
// "continue feeding", and banding such a case ROUTINE (home care) is a dangerous UNDER-call (a child
// who needs antibiotics sent home). PNEUMONIA/DEHYDRATION carry a (?<!NO ) lookbehind so the explicit
// "NO PNEUMONIA" / "NO DEHYDRATION" classifications still fall through to ROUTINE.
const NAMED_CONDITION_RE = /\b((?<!NO )PNEUMONIA|(?<!NO )DEHYDRATION|DYSENTERY|MALARIA|ANAEMIA|MALNUTRITION|EAR INFECTION|DEPRESSION|PSYCHOSIS|EPILEPSY|SELF-?HARM)\b/;
// "Yellow", part 2 — a treat/give disposition with no named condition. This LOSES to ROUTINE (a "give
// fluids, advise the mother" home-care line is routine), so it is checked after ROUTINE.
const DISPOSITION_RE = /\b(GIVE|TREAT|AMOXICILLIN|ANTIBIOTIC|ORS|ORAL REHYDRATION|FOLLOW-?UP)\b/;

/**
 * Map a model-produced classification + action to a triage band from the protocol wording alone.
 * Order matters: (1) severe/danger overrides everything; (2) a NAMED treatable condition is URGENT even
 * when the action carries counselling phrases (no under-call); (3) explicit mild/negation wording is
 * ROUTINE; (4) a bare treat/give disposition is URGENT; (5) a matched-but-unclear band defaults to URGENT
 * (a safe NON-emergency that still tells the worker to act) rather than guessing self-care.
 */
export function classifyToSeverity(classification: string, action: string): Severity {
  const t = `${classification} ${action}`.toUpperCase();
  if (EMERGENCY_RE.test(t)) return "EMERGENCY";
  if (NAMED_CONDITION_RE.test(t)) return "URGENT";
  if (ROUTINE_RE.test(t)) return "ROUTINE";
  if (DISPOSITION_RE.test(t)) return "URGENT";
  return "URGENT";
}

// General danger / emergency signs (WHO IMCI general danger signs + cough stridor + mhGAP imminent-risk).
// Broadened so a real emergency phrased in plain language is NOT missed (a miss would let the gate
// DOWNGRADE a true EMERGENCY — clinically the worst error). NOTE: "chest indrawing" and "fast
// breathing" are deliberately NOT here — alone they are the home-treatment (Yellow) band, not severe.
const DANGER_RE =
  /(unable to (?:drink|feed|breastfeed|wake|rouse)|not (?:been )?able to (?:drink|feed|breastfeed|wake)|cannot (?:drink|feed|wake)|can'?t (?:drink|feed|wake|keep)|won'?t (?:drink|feed|breastfeed|wake)|not (?:drinking|feeding|breastfeeding|waking|responding)|refus(?:es|ing) (?:to )?(?:drink|feed)|vomit(?:s|ing)? everything|convuls\w*|seizure|fits|lethargic|lethargy|drowsy|floppy|limp|unconscious|unrousable|unresponsive|very sleepy|won'?t wake|not waking|stridor|grunting|gasping|apno?ea|stopped breathing|not breathing|blue (?:lips|skin|tinge)|cyanos\w*|central cyanosis|severe respiratory distress|severe chest indrawing|coma|comatose|suicid\w*|self-?harm|harm (?:them|him|her)self|kill (?:them|him|her)self|bleeding heavily|severe dehydration|very (?:sick|weak|ill))/gi;

// Pneumonia-sign presentation: chest indrawing / fast breathing / an explicit breaths-per-minute count.
// The danger-sign gate ONLY downgrades when one of these IS present (a pure pneumonia presentation),
// so a case with no pneumonia signs keeps the model's band rather than being silently downgraded.
const PNEUMONIA_SIGN_RE = /(chest indrawing|fast breathing|breathing (?:at )?\d+|\d+ ?(?:breaths?\b|\/min|per minute|bpm))/i;

/**
 * Is a genuine emergency / general danger sign present in the case (or the model's red_flags)?
 * Negation-aware: "no stridor" / "denies vomiting" / "without convulsions" do NOT count.
 */
export function hasEmergencySign(caseText: string, redFlags: string[] = []): boolean {
  const hay = `${caseText} ${redFlags.join(" ")}`.toLowerCase();
  for (const m of hay.matchAll(DANGER_RE)) {
    const pre = hay.slice(Math.max(0, (m.index ?? 0) - 14), m.index);
    if (/\b(no|not|without|denies|denied|negative for|absent|free of|no signs of)\s*$/.test(pre)) continue;
    return true;
  }
  return false;
}

/**
 * Final severity for the card: the protocol-band mapping, then the danger-sign INVARIANT — a card may
 * be EMERGENCY only if the case actually presents an emergency sign. This neutralises the model's
 * intermittent over-escalation of chest indrawing (the 2014 IMCI merge) WITHOUT ever downgrading a real
 * danger-sign case (those keep their signs, so they stay EMERGENCY). Downgrade target is URGENT — still
 * "act / seek care", never dismissed.
 */
export function finalizeSeverity(
  classification: string,
  action: string,
  caseText: string,
  redFlags: string[] = [],
): Severity {
  const band = classifyToSeverity(classification, action);
  // Scoped danger-sign INVARIANT: only downgrade an EMERGENCY when the case is a PURE pneumonia-sign
  // presentation (chest indrawing / fast breathing) AND no emergency sign is present. This neutralises
  // the model's intermittent chest-indrawing over-escalation WITHOUT ever under-calling a genuine
  // danger-sign case — those either trip hasEmergencySign or lack a pneumonia sign, so they keep
  // EMERGENCY. A non-pneumonia case the model flags EMERGENCY is left as EMERGENCY (safe over-call).
  if (band === "EMERGENCY") {
    const hay = `${caseText} ${redFlags.join(" ")}`;
    if (!hasEmergencySign(caseText, redFlags) && PNEUMONIA_SIGN_RE.test(hay)) return "URGENT";
  }
  return band;
}

/**
 * REDESIGN severity (Tier B). When the classification is table-encoded (protocol-table.ts), severity is
 * the frozen colour-band value (Pink→EMERGENCY, Yellow→URGENT, Green→ROUTINE) — NOT a heuristic on model
 * prose — so a "MALARIA" case is URGENT by table law, deterministically. For an unencoded class it falls
 * back to the legacy classifyToSeverity heuristic. The danger-sign invariant then applies in BOTH
 * directions on top: a genuine general danger sign ESCALATES any band to EMERGENCY (WHO: a danger sign
 * means urgent referral), and a pure pneumonia-sign EMERGENCY with no danger sign is DOWNGRADED to URGENT
 * (the 2014 home-treatment merge — unchanged from finalizeSeverity). Negation-aware via hasEmergencySign.
 */
export function finalizeSeverityV2(
  classification: string,
  action: string,
  caseText: string,
  redFlags: string[] = [],
): Severity {
  const entry = lookupProtocol(classification);
  const base = entry ? entry.severity : classifyToSeverity(classification, action);
  // Escalate: a true general danger sign outranks any classification band.
  if (hasEmergencySign(caseText, redFlags)) return "EMERGENCY";
  // Downgrade: an EMERGENCY justified ONLY by a pneumonia sign (no danger sign) is the home-treatment band.
  if (base === "EMERGENCY" && PNEUMONIA_SIGN_RE.test(`${caseText} ${redFlags.join(" ")}`)) return "URGENT";
  return base;
}
