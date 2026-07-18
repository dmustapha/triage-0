// File: src/triage/class-router.ts
// THE semantic router (Phase 2 routing redesign, FINAL-POSITION 1A). Replaces the keyword sieve
// (protocol-table.ts allowedClassesFor) AND the chunk-retrieval abstain kill-switch as the routing gate.
//
// WHY THIS EXISTS. The old pipeline abstained the instant chunk retrieval found no WHO passage above the
// 0.685 cosine threshold — BEFORE the model ever ran. Lay ("the runs", "burning up"), abbreviated ("SOB,
// RR 58"), multi-symptom, and non-English phrasings don't embed close enough to any WHO chart CHUNK, so
// they silently abstained (baseline: 1/26 on the failure set). The fix decouples the two jobs the chunk
// score was overloaded with:
//   1. ROUTING / off-domain abstain  → this file: embed the case against 27 CLASS DESCRIPTORS (keyword-
//      agnostic prototypes), cosine, take the best. A truly off-domain case (adult cardiac, "capital of
//      France", veterinary) matches no descriptor well → abstain. Everything clinical routes.
//   2. GROUNDING / citation           → chunk retrieval (store.search) stays, but only to supply the cited
//      WHO passage and the reason-pass excerpts. It NO LONGER decides abstain.
//
// The shortlist (top classes by cosine) is passed to the extract pass as a PROMPT BIAS over the full
// 27-class enum — a soft nudge, not a hard grammar restriction. The 1.7B model still constrained-decodes
// the full enum (so a vocab-miss can't lock it out of the right class), and the deterministic reconcilers
// + danger-sign severity gate remain the backstop. Descriptors state WHO presenting SIGNS only (lay +
// clinical synonyms to raise case↔descriptor cosine); they carry no dose/severity, so they are a pure
// retrieval aid and cannot corrupt the deterministic safety layer.
import { embedBatchTimed, embedTimed } from "../qvac/engine.js";

/**
 * One descriptor per emittable WHO classification (CLASSIFICATION_ENUM minus UNKNOWN). Each is a
 * presenting-SIGNS sentence — the vocabulary a real case arrives in — blending clinical terms with lay
 * synonyms so an atypically-phrased case still embeds close to its class. Sourced from the IMCI decision
 * chart / mhGAP signs (the same signs encoded in PROTOCOL_TABLE + CLASS_REASONING). No treatment, no dose,
 * no severity band here — routing only.
 */
export const CLASS_PROTOTYPES: Record<string, string> = {
  // ── IMCI: cough / breathing ──────────────────────────────────────────────────────
  "SEVERE PNEUMONIA OR VERY SEVERE DISEASE":
    "Child with cough or difficult, fast or noisy breathing PLUS a general danger sign: not able to drink or feed, will not take the breast or milk, vomiting everything, convulsions, lethargic, unconscious or floppy, blue lips or tongue (cyanosis), grunting, or stridor when calm; chest wall drawing in. Severe, refer urgently.",
  PNEUMONIA:
    "Child with cough or difficult breathing and fast breathing for age (rapid breathing, high respiratory rate, short of breath) or lower chest-wall indrawing (ribs or tummy sucking in with each breath), but alert and feeding, no danger sign.",
  "COUGH OR COLD":
    "Child with a cough, runny or blocked nose, sneezing or sore throat, no fast breathing and no chest indrawing and no danger sign; mild self-limiting cold, may have a wheeze.",

  // ── IMCI: fever / malaria ────────────────────────────────────────────────────────
  "VERY SEVERE FEBRILE DISEASE":
    "Child with fever (hot, burning up, high temperature) PLUS a danger sign: stiff neck, bulging fontanelle (soft spot on the head), drowsy, unconscious, convulsions, vomiting everything, or not able to drink; covers meningitis, severe malaria, complicated measles (rash, red eyes, corneal clouding, mouth ulcers), and dengue warning signs (belly pain, bleeding, cold clammy). Refer urgently.",
  MALARIA:
    "Child with fever (hot, feverish, burning up) who lives in or recently visited a malaria or mosquito-illness area, with no malaria test done or a positive test, and no danger sign; treat as malaria.",
  "FEVER: NO MALARIA":
    "Child with fever but a NEGATIVE malaria test or no malaria risk area; fever from another cause, no danger sign.",

  // ── IMCI: diarrhoea ──────────────────────────────────────────────────────────────
  "SEVERE DEHYDRATION":
    "Child with diarrhoea, loose or watery stools, and severe fluid loss: lethargic or unconscious, very sunken eyes, not able to drink or drinking poorly, skin pinch goes back very slowly.",
  "SOME DEHYDRATION":
    "Child with diarrhoea, loose or watery stools (the runs, watery poo, going to the toilet loads), restless or irritable, sunken or hollow eyes, thirsty and drinks eagerly, skin pinch goes back slowly.",
  "NO DEHYDRATION":
    "Child with diarrhoea or loose stools but drinking normally, eyes not sunken, skin pinch normal, and no signs of dehydration.",
  DYSENTERY:
    "Child with diarrhoea containing blood, or blood and mucus in the stool (bloody diarrhoea); dysentery.",
  "PERSISTENT DIARRHOEA":
    "Child with diarrhoea or loose watery stools lasting 14 days or more (two weeks, several weeks); persistent diarrhoea.",
  "SEVERE PERSISTENT DIARRHOEA":
    "Child with diarrhoea lasting 14 days or more together with dehydration or a general danger sign; severe persistent diarrhoea, refer.",

  // ── IMCI: young infant — jaundice ─────────────────────────────────────────────────
  "SEVERE JAUNDICE":
    "Young infant with yellow skin and yellow eyes AND yellow palms or soles, or jaundice appearing within the first 24 hours of life; severe jaundice, refer urgently.",
  JAUNDICE:
    "Young infant with yellow skin or eyes appearing after 24 hours of age, palms and soles NOT yellow; mild jaundice, home care.",

  // ── IMCI: ear ────────────────────────────────────────────────────────────────────
  MASTOIDITIS:
    "Child with a tender, painful, boggy swelling or lump behind the ear (over the mastoid) pushing the ear forward; mastoiditis, refer urgently.",
  "ACUTE EAR INFECTION":
    "Child with ear pain or earache, tugging or pulling at the ear or lug, or pus/discharge/gunk draining from the ear for less than 14 days; ear infection (otitis).",
  "CHRONIC EAR INFECTION":
    "Child with pus or discharge draining from the ear for 14 days or more; chronic ear infection.",

  // ── IMCI: anaemia ────────────────────────────────────────────────────────────────
  "SEVERE ANAEMIA":
    "Child with SEVERE palmar pallor — very white, washed-out palms — plus tiredness or breathlessness; severe anaemia, refer urgently.",
  ANAEMIA:
    "Child with pale or white palms (palmar pallor), tired, worn out, or gets breathless and puffed out on exertion; anaemia.",

  // ── IMCI: acute malnutrition ─────────────────────────────────────────────────────
  "SEVERE ACUTE MALNUTRITION":
    "Child who is very thin or visibly severely wasted, very low arm circumference (MUAC), or has swelling and oedema of both feet that pits on pressure, refusing food and listless; severe acute malnutrition.",
  "MODERATE ACUTE MALNUTRITION":
    "Child who is thin or moderately wasted with low arm circumference (MUAC) but NO oedema of the feet and no severe wasting; moderate acute malnutrition.",

  // ── mhGAP: mental, neurological, substance-use ───────────────────────────────────
  DEPRESSION:
    "Adult with persistent low or sad mood, tearfulness, loss of interest or pleasure, hopelessness or worthlessness, poor sleep and appetite, and low energy for two weeks or more; depression.",
  PSYCHOSIS:
    "Adult hearing voices others cannot hear, seeing things, holding false fixed beliefs (delusions) or paranoia (being spied on or poisoned), with disorganised or agitated behaviour; psychosis.",
  EPILEPSY:
    "Person with recurrent unprovoked seizures, convulsions, fits, or jerking movements with loss of awareness or consciousness, normal between episodes; epilepsy.",
  "SELF-HARM / SUICIDE":
    "Person with thoughts, a plan, or an act of self-harm or suicide — an overdose, a self-inflicted injury, or wanting to die; self-harm emergency.",
  "BIPOLAR DISORDER":
    "Adult with episodes of elevated, elated or irritable mood, overactivity and reduced need for sleep, alternating with periods of depression; bipolar disorder or mania.",
  DEMENTIA:
    "Older adult with progressive memory loss, confusion, and decline in the ability to carry out daily activities; dementia.",
  "DISORDERS DUE TO SUBSTANCE USE":
    "Person with harmful or dependent use of alcohol or drugs — cannot cut down or stop, drinks or uses daily, withdrawal shakes, cravings; substance use disorder.",
};

/**
 * IMCI/mhGAP main-symptom groups over the 27 classes. `order` documents the IMCI antibiotic-lead / severity
 * precedence (respiratory & fever & blood-in-stool lead over plain dehydration and ear) that
 * reconcileMultiSymptom applies deterministically. This map also feeds CLASS_GROUP, which the structural
 * guard test asserts covers every routable class. (It is intentionally NOT used to widen the shortlist —
 * see scoreVector for why group-spanning was removed.)
 */
const SYMPTOM_GROUPS: { group: string; order: number; classes: string[] }[] = [
  { group: "respiratory", order: 1, classes: ["SEVERE PNEUMONIA OR VERY SEVERE DISEASE", "PNEUMONIA", "COUGH OR COLD"] },
  { group: "fever", order: 2, classes: ["VERY SEVERE FEBRILE DISEASE", "MALARIA", "FEVER: NO MALARIA"] },
  { group: "dysentery", order: 3, classes: ["DYSENTERY"] },
  { group: "malnutrition", order: 4, classes: ["SEVERE ACUTE MALNUTRITION", "MODERATE ACUTE MALNUTRITION"] },
  { group: "anaemia", order: 5, classes: ["SEVERE ANAEMIA", "ANAEMIA"] },
  { group: "ear", order: 6, classes: ["MASTOIDITIS", "ACUTE EAR INFECTION", "CHRONIC EAR INFECTION"] },
  { group: "diarrhoea", order: 7, classes: ["SEVERE DEHYDRATION", "SOME DEHYDRATION", "NO DEHYDRATION", "PERSISTENT DIARRHOEA", "SEVERE PERSISTENT DIARRHOEA"] },
  { group: "jaundice", order: 8, classes: ["SEVERE JAUNDICE", "JAUNDICE"] },
  { group: "mental", order: 9, classes: ["DEPRESSION", "PSYCHOSIS", "EPILEPSY", "SELF-HARM / SUICIDE", "BIPOLAR DISORDER", "DEMENTIA", "DISORDERS DUE TO SUBSTANCE USE"] },
];
/** class → {group, order} lookup, built once from SYMPTOM_GROUPS. Exported for the structural guard test. */
export const CLASS_GROUP: Record<string, { group: string; order: number }> = Object.fromEntries(
  SYMPTOM_GROUPS.flatMap((g) => g.classes.map((c) => [c, { group: g.group, order: g.order }])),
);

// ── unit-vector cache (embed the descriptors once per model) ──────────────────────
interface Prototype {
  cls: string;
  vec: Float64Array;
}
let _protos: Prototype[] | null = null;
let _protoModelId: string | null = null;

/** L2-normalise so a dot product is the cosine similarity (GTE vectors are not guaranteed unit-length). */
function unit(v: number[]): Float64Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a: Float64Array, b: Float64Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

/**
 * Embed the 27 class descriptors once (a single batched embed call) and cache the unit vectors. Cheap and
 * idempotent — a no-op after the first call for a given embeddings model. Call at server warm-up so the
 * first real /triage pays nothing.
 */
export async function ensureClassPrototypes(embedModelId: string): Promise<void> {
  if (_protos && _protoModelId === embedModelId) return;
  const entries = Object.entries(CLASS_PROTOTYPES);
  const { vectors } = await embedBatchTimed({
    modelId: embedModelId,
    texts: entries.map(([, text]) => text),
    phase: "route",
  });
  _protos = entries.map(([cls], i) => ({ cls, vec: unit(vectors[i]) }));
  _protoModelId = embedModelId;
}

export interface RouteResult {
  /** Classes ranked by cosine (desc): the top candidates for the extract prompt bias. */
  shortlist: { cls: string; score: number }[];
  /** The single best cosine — the off-domain signal. */
  best: number;
  /** best < OFF_DOMAIN_THRESHOLD → the case matches no WHO class well enough to route; abstain. */
  offDomain: boolean;
}

/** Off-domain abstain threshold. Below this best-cosine, the case is out of the IMCI/mhGAP scope and
 *  Triage-0 escalates rather than guess. Calibrated 2026-07-18 on the failure + textbook sets
 *  (scripts/calibrate-router.ts): the must-abstain cases top out at A3=0.819 / RA7-PTSD=0.826, the
 *  must-pass V/MS/CB bottom out at V1=0.870, and the lowest textbook clinical case is X3=0.862. 0.84 sits
 *  cleanly in that gap — it abstains A1(0.781)/A2(0.692)/A3(0.819) and the un-encoded RA7 PTSD (0.826),
 *  while passing every V/MS/CB and every textbook clinical case. (Non-English NE cases score low here by
 *  design; Phase 4 translates them to English BEFORE routing.) Overridable via ROUTER_OFF_DOMAIN. */
export const OFF_DOMAIN_THRESHOLD = Number(process.env.ROUTER_OFF_DOMAIN ?? 0.84);
/** Always shortlist at least this many classes (so a near-tie second class is offered to the model). */
const SHORTLIST_MIN = 3;
/** Include any class within this cosine margin of the best (surfaces near-tie candidates). */
const SHORTLIST_MARGIN = 0.06;
/** Never bias with more than this many classes (keep the prompt focused). */
const SHORTLIST_MAX = 5;

/** Score one already-embedded case vector against the cached prototypes. Exposed for the debug/calibration
 *  path (which embeds in a batch) so it does not re-embed per case.
 *
 *  The shortlist is a TIGHT, score-ranked top-N — deliberately NOT group-spanning. An earlier group-span
 *  variant (inject the best class of every nearby symptom group) regressed single-symptom cases: their
 *  second-best group sits only ~0.03–0.05 below the winner in cosine space (the descriptors share
 *  vocabulary), so it injected severe cross-symptom distractors (VERY SEVERE FEBRILE DISEASE, SEVERE
 *  DEHYDRATION) that the model then over-picked. Multi-symptom PRIMARY selection is handled deterministically
 *  and precisely by reconcileMultiSymptom (explicit WHO sign detection) instead — the correct tool. */
export function scoreVector(caseVec: number[]): RouteResult {
  if (!_protos) throw new Error("class prototypes not initialised — call ensureClassPrototypes first");
  const q = unit(caseVec);
  const scored = _protos
    .map((p) => ({ cls: p.cls, score: dot(q, p.vec) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  const shortlist = scored
    .filter((s, i) => i < SHORTLIST_MIN || best - s.score <= SHORTLIST_MARGIN)
    .slice(0, SHORTLIST_MAX);
  return { shortlist, best, offDomain: best < OFF_DOMAIN_THRESHOLD };
}

/**
 * THE routing entry point: embed the case, score it against the class prototypes, return the shortlist +
 * off-domain verdict. Truncates the query to the embedder's context (mirrors retrieveGrounding). The
 * reasoning/extract passes still see the full case.
 */
export async function routeCase(caseText: string, embedModelId: string): Promise<RouteResult> {
  await ensureClassPrototypes(embedModelId);
  const { vector } = await embedTimed({ modelId: embedModelId, text: caseText.slice(0, 1500), phase: "route" });
  return scoreVector(vector);
}
