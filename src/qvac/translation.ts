// File: src/qvac/translation.ts
// Phase 4 multilingual (FINAL-POSITION 1C). On-device language detection + Bergamot NMT, both via the
// @qvac SDK's Node-safe bridge (langdetect is pure; translation goes through modelType "nmtcpp-translation"
// — the direct @qvac/translation-nmtcpp class is Bare-runtime-only and throws under Node).
//
// Flow: detect the case language → if FR/ES, translate the CASE to English BEFORE routing (routing, RAG,
// the WHO table and every reconciler run in English); after the card + plan are built, translate them BACK
// to the source language and flag the card `translated` (banner: "translated — not verbatim WHO"). The
// English `protocol_citation` / component `citation`s are ALWAYS kept for provenance.
//
// Safety: never crash a request on a translation fault. Input-side failure → route the ORIGINAL text
// (degraded, as pre-Phase-4). Output-side failure → return the English card/plan with `translated:false`.
import { detectOne } from "@qvac/langdetect-text";
import { orchestrator } from "./orchestrator.js";
import { translateTimed } from "./engine.js";
import { translations, TRANSLATION_LANGS, type TranslationLang } from "../config.js";
import type { TriageCard, ManagementPlan } from "../triage/schema.js";

export type CaseLang = "en" | TranslationLang;

/** Detect the case language. Returns a SUPPORTED non-English code only when langdetect's top pick is FR/ES;
 *  everything else (incl. English, "und", or a fault) → "en" (no-op, route as today). NO probability floor:
 *  clinical French scores only ~0.45 on detectMultiple, so a floor would wrongly drop it — the top code is
 *  the reliable signal, and the English-no-regression unit test is the guard against a false FR/ES tag. */
export function detectSourceLanguage(text: string): CaseLang {
  try {
    const code = detectOne(text)?.code;
    return (TRANSLATION_LANGS as readonly string[]).includes(code) ? (code as TranslationLang) : "en";
  } catch {
    return "en";
  }
}

/** Sequential map — the @qvac inference engine is SINGLE-JOB ("Stale job replaced by new run" if a second
 *  inference starts while one is running), so translate calls must NEVER run via Promise.all. */
async function mapSeq<T, R>(arr: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of arr) out.push(await fn(x));
  return out;
}

/** Translate one string via the src>dst Bergamot model (loaded + kept resident by the orchestrator). Empty
 *  / whitespace strings short-circuit (Bergamot on "" is wasteful and can echo junk). */
async function translateText(text: string, from: CaseLang, to: CaseLang): Promise<string> {
  if (from === to || !text.trim()) return text;
  const spec = translations[`${from}>${to}`];
  if (!spec) throw new Error(`no translation model for ${from}>${to}`);
  const modelId = await orchestrator.ensure(spec, "translate");
  const { text: out } = await translateTimed({ modelId, text, phase: "translate" });
  return out;
}

/** INPUT side: detect + translate the case to English before routing. Degrades to the original text on any
 *  fault so routing still runs (it will simply behave as the pre-Phase-4 English-only path). */
export async function translateCaseToEnglish(
  caseText: string,
): Promise<{ english: string; sourceLang: CaseLang }> {
  const sourceLang = detectSourceLanguage(caseText);
  if (sourceLang === "en") return { english: caseText, sourceLang: "en" };
  try {
    const english = await translateText(caseText, sourceLang, "en");
    return { english, sourceLang };
  } catch (err) {
    console.warn(`[translation] input translate ${sourceLang}->en failed, routing original text:`, (err as Error).message);
    return { english: caseText, sourceLang: "en" };
  }
}

/** Translate the plan's human-facing strings to `lang`, preserving structure + every English citation. */
async function translatePlan(plan: ManagementPlan, lang: CaseLang): Promise<ManagementPlan> {
  const tr = (s: string) => translateText(s, "en", lang);
  const medicines = await mapSeq(plan.medicines, async (m) => ({
    ...m,
    name: await tr(m.name),
    ...(m.strength !== undefined && { strength: await tr(m.strength) }),
    ...(m.dose !== undefined && { dose: await tr(m.dose) }),
    ...(m.frequency !== undefined && { frequency: await tr(m.frequency) }),
    ...(m.duration !== undefined && { duration: await tr(m.duration) }),
    ...(m.bands && { bands: await mapSeq(m.bands, async (b) => ({ band: await tr(b.band), dose: await tr(b.dose) })) }),
  }));
  const supportive = await mapSeq(plan.supportive, async (s) => ({ ...s, item: await tr(s.item) }));
  const home_care = await mapSeq(plan.home_care, async (h) => ({ ...h, advice: await tr(h.advice) }));
  const return_now = await mapSeq(plan.return_now, async (r) => ({ ...r, sign: await tr(r.sign) }));
  const follow_up = plan.follow_up
    ? { ...plan.follow_up, when: await tr(plan.follow_up.when), ...(plan.follow_up.detail !== undefined && { detail: await tr(plan.follow_up.detail) }) }
    : plan.follow_up;
  const referral = plan.referral ? { ...plan.referral, criterion: await tr(plan.referral.criterion) } : plan.referral;
  return { medicines, supportive, home_care, return_now, follow_up, referral };
}

/** OUTPUT side (plan only) — for the streaming server path, which emits the card and the plan as SEPARATE
 *  events (card-first). English → unchanged; on fault → the English plan (never break the plan event). */
export async function translatePlanFromEnglish(
  plan: ManagementPlan,
  sourceLang: CaseLang,
): Promise<ManagementPlan> {
  if (sourceLang === "en") return plan;
  try {
    return await translatePlan(plan, sourceLang);
  } catch (err) {
    console.warn(`[translation] output plan translate en->${sourceLang} failed, returning English plan:`, (err as Error).message);
    return plan;
  }
}

/** OUTPUT side: translate the card (and optional plan) back to the source language and flag it. English
 *  input → unchanged. On any fault → English content with `translated:false` (never break the card). */
export async function translateCardAndPlanFromEnglish(
  card: TriageCard,
  plan: ManagementPlan | undefined,
  sourceLang: CaseLang,
): Promise<{ card: TriageCard; plan: ManagementPlan | undefined }> {
  if (sourceLang === "en") return { card, plan };
  try {
    const tr = (s: string) => translateText(s, "en", sourceLang);
    const translatedCard: TriageCard = {
      ...card,
      action: await tr(card.action),
      reasoning: await tr(card.reasoning),
      red_flags: await mapSeq(card.red_flags, tr),
      source_language: sourceLang,
      translated: true,
    };
    const translatedPlan = plan ? await translatePlan(plan, sourceLang) : plan;
    return { card: translatedCard, plan: translatedPlan };
  } catch (err) {
    console.warn(`[translation] output translate en->${sourceLang} failed, returning English card:`, (err as Error).message);
    return { card: { ...card, source_language: sourceLang, translated: false }, plan };
  }
}
