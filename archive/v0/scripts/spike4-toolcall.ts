// File: spike4f-tools.ts — CONFIRM the LOCKED Phase-2 design.
// Findings across 4a-4e: MedPsy-1.7B (a) won't tool-call in any dialect; (b) reasons CORRECTLY in
// free prose (right classification + action every time); (c) cannot reliably apply an abstract 4-way
// severity mapping; (d) responseFormat:json_schema guarantees valid JSON shape. So:
//   pass-1 reason (free think) -> CONCLUSION: <classification> — <action>
//   pass-2 json_schema EXTRACT {classification, action, reasoning, red_flags}  (extraction, model is good at it)
//   severity = deterministic code mapping over (classification + action)         (auditable, unit-tested)
// Confirm severity lands right on both cases via the deterministic map.
//
// Run: node --import tsx scripts/spike4f-tools.ts
import { loadModel, completion, unloadModel, close } from "@qvac/sdk";
const MEDPSY = new URL("../.models/medpsy-1.7b-q4_k_m-imat.gguf", import.meta.url).pathname;

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    classification: { type: "string", description: "The WHO classification name from the assessment, e.g. PNEUMONIA." },
    action: { type: "string", description: "The exact treatment/next-step from the matched classification line." },
    reasoning: { type: "string" },
    red_flags: { type: "array", items: { type: "string" } },
  },
  required: ["classification", "action", "reasoning", "red_flags"], additionalProperties: false,
} as const;

const GROUNDING = `CRITICAL: the excerpt lists which signs map to which classification. Use ONLY that mapping — never reclassify a sign from memory or older guidelines. Match the case's signs to the excerpt line listing those exact signs, then take that line's classification AND its action.`;
const SYS_REASON = `You are Triage-0, a clinical decision-support assistant for a community health worker. ${GROUNDING}
Think step by step, then end with one line: CONCLUSION: <classification> — <exact action from that line>.`;
const SYS_EXTRACT = `Extract structured fields from the CLINICAL ASSESSMENT. "classification" = the WHO classification named in the CONCLUSION. "action" = the treatment/next-step quoted from the CONCLUSION verbatim. Do not invent or re-diagnose. Emit ONLY the JSON.`;

// ---- deterministic severity mapping (will live in src/triage/severity.ts, unit-tested) ----
function classifyToSeverity(classification: string, action: string): string {
  const t = `${classification} ${action}`.toUpperCase();
  if (/\b(VERY SEVERE|SEVERE|DANGER SIGN|REFER URGENT|REFER IMMEDIAT|FIRST DOSE)\b/.test(t)) return "EMERGENCY";
  if (/\b(PNEUMONIA|DEHYDRATION|INFECTION|DYSENTERY|MALARIA|ANAEMIA|MALNUTRITION|DEPRESSION|PSYCHOSIS|GIVE|TREAT|AMOXICILLIN|ANTIBIOTIC|ORS|ORAL REHYDRATION|FOLLOW-?UP)\b/.test(t)) return "URGENT";
  if (/\b(COUGH OR COLD|NO PNEUMONIA|HOME CARE|ADVISE|SOOTHE|CONTINUE FEEDING)\b/.test(t)) return "ROUTINE";
  return "URGENT"; // matched a protocol but unclear band -> safe non-emergency default
}

const EXCERPT =
  "WHO IMCI Chart Booklet (2014), p.6 — Cough or difficult breathing. " +
  "Chest indrawing OR Fast breathing -> PNEUMONIA: give oral Amoxicillin for 5 days, advise return immediately if worse, follow-up in 3 days. " +
  "Any general danger sign OR stridor in a calm child -> SEVERE PNEUMONIA OR VERY SEVERE DISEASE: give first dose of antibiotic, refer URGENTLY to hospital.";
const CASES = [
  { id: "pneumonia(chest-indrawing)", want: "URGENT",
    case: "2-year-old, cough 3 days, chest indrawing, breathing 42/min, alert, drinking, no danger signs." },
  { id: "severe(danger-sign)", want: "EMERGENCY",
    case: "11-month-old, cough, lethargic and unable to drink, breathing 60/min with chest indrawing and stridor while calm." },
];

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "").trim();
const parseJson = (s: string) => { const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} } return null; };
async function comp(modelId: string, history: any[], params: Record<string, unknown>) {
  const t0 = performance.now(); const run: any = completion({ modelId: modelId as any, history, stream: true, ...params });
  for await (const _ of run.events as AsyncIterable<any>) { /* drain */ }
  const f: any = await run.final; return { text: f.contentText ?? "", ms: Math.round(performance.now() - t0) };
}

async function main() {
  const modelId = (await loadModel({ modelSrc: MEDPSY, modelType: "llm", modelConfig: { ctx_size: 4096 } })) as string;
  console.log(`loaded ${modelId}`);
  let allPass = true;
  for (const c of CASES) {
    const body = `PROTOCOL EXCERPT:\n${EXCERPT}\n\nPATIENT CASE: ${c.case}`;
    const r = await comp(modelId, [{ role: "system", content: SYS_REASON }, { role: "user", content: `${body}\n\nGive your assessment.` }], { generationParams: { predict: 1100 } });
    const reasoned = stripThink(r.text);
    const x = await comp(modelId, [{ role: "system", content: SYS_EXTRACT }, { role: "user", content: `CLINICAL ASSESSMENT:\n${reasoned}\n\nEmit the JSON now.` }], { responseFormat: { type: "json_schema", json_schema: { name: "extract", schema: EXTRACT_SCHEMA } } });
    const ex = parseJson(x.text);
    const sev = ex ? classifyToSeverity(ex.classification ?? "", ex.action ?? "") : "PARSE_FAIL";
    const pass = sev === c.want;
    allPass = allPass && pass;
    console.log(`\n############ ${c.id}  want=${c.want}  got=${sev}  ${pass ? "✅" : "❌"}  (${r.ms + x.ms}ms)`);
    console.log(`  classification="${ex?.classification}"  action="${(ex?.action ?? "").slice(0, 70)}"`);
    console.log(`  red_flags=${JSON.stringify(ex?.red_flags)}`);
    console.log(`  conclusion: ${(reasoned.match(/CONCLUSION:.*/i)?.[0] ?? "(none)").slice(0, 130)}`);
  }
  console.log(`\n=== LOCKED DESIGN ${allPass ? "CONFIRMED ✅" : "STILL FAILING ❌"} ===`);
  await unloadModel({ modelId } as any); close();
}
main().catch((e) => { console.error("SPIKE FAILED:", e); try { close(); } catch {} process.exit(1); });
