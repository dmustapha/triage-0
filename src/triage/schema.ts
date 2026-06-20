// File: src/triage/schema.ts
// The triage card contract (rendered by the UI, returned by /triage) + the model's EXTRACT contract.
// RECONCILED for Phase 2 (RECONCILE.md "Phase-2 Tool-Calling reconciliation"): MedPsy-1.7B will NOT
// tool-call, so the card is NOT produced by completion({tools}). Instead the model reasons in prose
// then EXTRACTS structured fields under a responseFormat:json_schema grammar; `severity` is derived in
// code (severity.ts) and `protocol_citation` is injected from the retrieved chunk — neither is model-
// authored. This keeps the two things the model is bad at (severity bucketing, citing) out of its hands.
import { z } from "zod";

export const SEVERITIES = ["EMERGENCY", "URGENT", "ROUTINE", "SELF_CARE", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A citation injected from a real retrieved chunk (never model-authored). Used by every plan line. */
export const PlanCitationSchema = z.object({
  doc: z.string().min(1), // e.g. "WHO IMCI Chart Booklet (2014)"
  page: z.union([z.number().int(), z.string()]),
});
export type PlanCitation = z.infer<typeof PlanCitationSchema>;

/**
 * The grounded WHO management plan (Task #22). Assembled from MULTIPLE retrieved chunks, each line
 * carrying the page it was grounded against. Built by triage.ts: the model proposes verbatim, non-
 * numeric phrases; a deterministic guard validates each line against a retrieved chunk and injects the
 * citation from that chunk. Dose is never a model number — it is the protocol's weight-band guidance.
 * Any component with no clearing chunk is omitted (graceful partial plan), so every array is optional.
 */
export const ManagementPlanSchema = z.object({
  medicines: z
    .array(
      z.object({
        name: z.string().min(1),
        dose: z.string().optional(), // weight-band guidance, e.g. "By age/weight band" — NEVER a fabricated mg
        frequency: z.string().optional(), // e.g. "Two times daily"
        duration: z.string().optional(), // e.g. "5 days"
        citation: PlanCitationSchema,
      }),
    )
    .default([]),
  supportive: z.array(z.object({ item: z.string().min(1), citation: PlanCitationSchema })).default([]),
  home_care: z.array(z.object({ advice: z.string().min(1), citation: PlanCitationSchema })).default([]),
  return_now: z.array(z.object({ sign: z.string().min(1), citation: PlanCitationSchema })).default([]),
  follow_up: z.object({ when: z.string().min(1), citation: PlanCitationSchema }).nullable().default(null),
  referral: z.object({ criterion: z.string().min(1), citation: PlanCitationSchema }).nullable().default(null),
});
export type ManagementPlan = z.infer<typeof ManagementPlanSchema>;

/** The triage card surfaced to the health worker. `protocol_citation` always resolves to a real
 *  ingested WHO chunk (never invented). `plan` is the grounded management plan (Task #22), attached
 *  after the classification; absent on the abstain path. */
export const TriageCardSchema = z.object({
  severity: z.enum(SEVERITIES),
  action: z.string().min(1),
  protocol_citation: z.object({
    doc: z.string().min(1), // e.g. "WHO IMCI Chart Booklet (2014)"
    page: z.union([z.number().int(), z.string()]), // page number or label
    section: z.string().min(1), // verbatim snippet / section anchor
  }),
  reasoning: z.string().min(1),
  red_flags: z.array(z.string()).default([]),
  plan: ManagementPlanSchema.optional(),
});
export type TriageCard = z.infer<typeof TriageCardSchema>;

/**
 * What the model EXTRACTS in the json_schema pass — only fields the model produces reliably:
 * the classification it concluded, the action on that classification's protocol line, its reasoning,
 * and any danger signs. NO severity (derived in severity.ts) and NO citation (injected from retrieval).
 */
export const TriageExtractSchema = z.object({
  classification: z.string().min(1), // WHO classification name, e.g. "PNEUMONIA"
  action: z.string().min(1),
  reasoning: z.string().min(1),
  red_flags: z.array(z.string()).default([]),
});
export type TriageExtract = z.infer<typeof TriageExtractSchema>;

/**
 * JSON Schema literal handed to completion({ responseFormat: { type:"json_schema", json_schema:{schema} } }).
 * Verified live: llama.cpp converts this to GBNF and constrains generation, so the output is always a
 * shape-valid object. (Full nesting/items ARE honoured here — unlike the flat native tool schema.)
 */
export const TRIAGE_EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    classification: { type: "string", description: "The WHO classification named in the assessment, e.g. PNEUMONIA, SEVERE PNEUMONIA OR VERY SEVERE DISEASE." },
    action: { type: "string", description: "The exact treatment / next step on the matched classification's protocol line." },
    reasoning: { type: "string", description: "Brief justification citing the matched signs." },
    red_flags: { type: "array", items: { type: "string" }, description: "Danger signs present in the case, if any." },
  },
  required: ["classification", "action", "reasoning", "red_flags"],
  additionalProperties: false,
} as const;

/**
 * What the model proposes in the plan-assemble pass (Task #22). NO citations (injected in code from the
 * matched chunk), NO doses/numbers (dose is the protocol's weight-band guidance, built in code). Every
 * string MUST be copied verbatim from the supplied PROTOCOL EXCERPTS; the deterministic groundPlan()
 * guard drops anything that does not match a retrieved chunk, so an empty field is always safe.
 */
export const PlanExtractSchema = z.object({
  medicines: z.array(z.string()).default([]),
  supportive: z.array(z.string()).default([]),
  home_care: z.array(z.string()).default([]),
  return_now: z.array(z.string()).default([]),
  follow_up: z.string().default(""),
  referral: z.string().default(""),
});
export type PlanExtract = z.infer<typeof PlanExtractSchema>;

// FLAT schema only (strings + arrays-of-strings) — the same shape the main triage extract uses, which
// MedPsy-1.7B fills reliably. A nested object array (medicines:[{name,dose,...}]) makes the GBNF grammar
// too hard for a 1.7B model and it returns empty. So medicines are verbatim LINES here; triage.ts
// derives name/frequency/duration/dose from each grounded line deterministically.
export const PLAN_EXTRACT_JSON_SCHEMA = {
  type: "object",
  properties: {
    medicines: { type: "array", items: { type: "string" }, description: "One line per medicine/fluid the excerpts prescribe for this classification, copied VERBATIM (e.g. 'Give oral Amoxicillin for 5 days', 'Give zinc supplements', 'Give fluid (Plan B)'). Include antibiotics, ORS, zinc, antimalarials, antidepressants. Do NOT add mg/ml/weight numbers." },
    supportive: { type: "array", items: { type: "string" }, description: "Supportive/symptomatic care lines copied verbatim (paracetamol for high fever, vitamin A, continue breastfeeding, psychosocial support). Empty if none." },
    home_care: { type: "array", items: { type: "string" }, description: "Home-care counselling lines copied verbatim (give extra fluids, continue feeding, soothe the throat). Empty if none." },
    return_now: { type: "array", items: { type: "string" }, description: "Signs/instruction that mean return immediately, copied verbatim (e.g. 'Advise mother when to return immediately'). Empty if none." },
    follow_up: { type: "string", description: "Verbatim follow-up instruction, e.g. 'Follow-up in 3 days'. Empty if none." },
    referral: { type: "string", description: "Verbatim referral instruction if required, e.g. 'Refer URGENTLY to hospital'. Empty if none." },
  },
  required: ["medicines", "supportive", "home_care", "return_now", "follow_up", "referral"],
  additionalProperties: false,
} as const;
