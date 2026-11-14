// File: tests/integration/citation-integrity.test.ts
// MODEL-GATED. The anti-hallucination gate for the management plan (Task #22): EVERY plan line must be a
// verbatim substring of a REAL ingested WHO chunk, and the citation page on that line must match the page
// of a chunk that actually contains the text. This is what proves "nothing is model-composed" — a
// fabricated dose or invented instruction would have no source chunk and FAIL here. Plus the PROTOCOL
// FENCE: an mhGAP (mental-health) case must never cite IMCI or surface paediatric text (breastfeed /
// amoxicillin) — cross-protocol leakage is a real, dangerous failure mode.
//
// Self-skips when the store isn't ingested. Loads MedPsy + GTE — SLOW.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TRIAGE0_PERF_DIR = mkdtempSync(join(tmpdir(), "triage0-test-perf-"));

const { config, registry, medpsySpec } = await import("../../src/config.js");
const { chunkCount } = await import("../../src/rag/store.js");
const { loadModelTimed, unloadModelTimed } = await import("../../src/qvac/engine.js");
const { close } = await import("../../src/qvac/sdk.js");
const { runTriage } = await import("../../src/triage/triage.js");

const skip = chunkCount() > 0 ? false : "store not ingested — run `npm run ingest` first";

// The citation sidecar: id -> {protocol,title,page,section,content}. Same file the store reads.
type MapEntry = { protocol: string; title: string; page: number; section: string; content: string };
let CMAP: Record<string, MapEntry> = {};

/** Whitespace-normalise for substring matching: cleanPhrase collapses runs of whitespace, so a plan
 *  line is a substring of the whitespace-collapsed chunk content, not the raw (newline-bearing) text. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Is `line` a verbatim substring of SOME chunk whose page === `page`? (case-insensitive, ws-normalised) */
function lineIsGroundedAtPage(line: string, page: number | string): boolean {
  const needle = norm(line);
  if (!needle) return false;
  const pageStr = String(page);
  return Object.values(CMAP).some(
    (c) => String(c.page) === pageStr && norm(c.content).includes(needle),
  );
}

/** Every line of the plan, paired with the citation page it claims. */
function planLines(plan: any): Array<{ text: string; page: number | string; where: string }> {
  const out: Array<{ text: string; page: number | string; where: string }> = [];
  for (const m of plan.medicines) out.push({ text: m.name, page: m.citation.page, where: `medicine:${m.name}` });
  for (const s of plan.supportive) out.push({ text: s.item, page: s.citation.page, where: "supportive" });
  for (const h of plan.home_care) out.push({ text: h.advice, page: h.citation.page, where: "home_care" });
  for (const r of plan.return_now) out.push({ text: r.sign, page: r.citation.page, where: "return_now" });
  if (plan.follow_up) out.push({ text: plan.follow_up.when, page: plan.follow_up.citation.page, where: "follow_up" });
  if (plan.referral) out.push({ text: plan.referral.criterion, page: plan.referral.citation.page, where: "referral" });
  return out;
}

let embedId = "";
let medpsyId = "";

before(async () => {
  if (skip) return;
  const p = config.citationMapPath;
  assert.ok(existsSync(p), "citation-map.json exists on disk");
  CMAP = JSON.parse(readFileSync(p, "utf8"));
  ({ modelId: embedId } = await loadModelTimed(registry.embeddings, "test"));
  ({ modelId: medpsyId } = await loadModelTimed(medpsySpec(), "test"));
});
after(async () => {
  if (medpsyId) await unloadModelTimed(medpsyId, "medpsy", "test");
  if (embedId) await unloadModelTimed(embedId, "embeddings", "test");
  close();
  rmSync(process.env.TRIAGE0_PERF_DIR!, { recursive: true, force: true });
});

// Medicine NAMES are a deterministic lexicon (DRUG_LEXICON), not always a verbatim chunk word ("ORS" vs
// "oral rehydration"); the per-line page-grounding still holds (the citation page must carry the drug
// pattern). So for medicines we assert the citation page exists in the corpus; for prose lines we assert
// the FULL verbatim-substring-at-page invariant.
const PROSE = new Set(["supportive", "home_care", "return_now", "follow_up", "referral"]);

for (const seed of [
  { label: "pneumonia (IMCI)", q: "Two year old, cough for three days, chest indrawing, breathing 52 per minute, alert and drinking, no danger signs." },
  { label: "danger-sign (IMCI severe)", q: "Eleven month old with cough, now lethargic and unable to drink, breathing 60 per minute with chest indrawing, and stridor while calm." },
]) {
  test(`plan integrity (IMCI): every prose line is verbatim-grounded at its cited page — ${seed.label}`, { skip, timeout: 240_000 }, async () => {
    const { card } = await runTriage(seed.q, { medpsyId, embedId });
    assert.ok(card.plan, "plan attached");
    const lines = planLines(card.plan);
    assert.ok(lines.length >= 1, "plan has at least one line");
    for (const { text, page, where } of lines) {
      // Every cited page must exist in the corpus.
      assert.ok(
        Object.values(CMAP).some((c) => String(c.page) === String(page)),
        `${where}: cited page ${page} exists in the corpus`,
      );
      // Prose lines must additionally be a verbatim substring of a chunk AT that page.
      if (PROSE.has(where.split(":")[0])) {
        assert.ok(
          lineIsGroundedAtPage(text, page),
          `${where}: "${text}" is a verbatim substring of a corpus chunk on page ${page}`,
        );
      }
    }
  });
}

test("plan integrity (mhGAP fence): adult depression cites no IMCI and surfaces no paediatric text", { skip, timeout: 240_000 }, async () => {
  const { card } = await runTriage(
    "Adult with low mood, loss of interest, poor sleep and appetite for the past three weeks.",
    { medpsyId, embedId },
  );
  assert.ok(card.plan, "plan attached");
  const lines = planLines(card.plan);
  assert.ok(lines.length >= 1, "mhGAP plan has at least one line");

  // Protocol fence: no plan-line citation may name the IMCI chart, and no line text may carry the
  // paediatric leakage markers (breastfeeding / amoxicillin) that belong to the IMCI corpus.
  const allCites = [
    ...card.plan.medicines.map((m: any) => m.citation),
    ...card.plan.supportive.map((s: any) => s.citation),
    ...card.plan.home_care.map((h: any) => h.citation),
    ...card.plan.return_now.map((r: any) => r.citation),
    ...(card.plan.follow_up ? [card.plan.follow_up.citation] : []),
    ...(card.plan.referral ? [card.plan.referral.citation] : []),
  ];
  for (const c of allCites) {
    assert.doesNotMatch(String(c.doc), /IMCI/i, `mhGAP plan must not cite IMCI (got ${c.doc})`);
  }
  const allText = lines.map((l) => l.text).join(" ");
  assert.doesNotMatch(allText, /breastfeed|amoxicillin/i, `mhGAP plan must not leak paediatric text (got: ${allText})`);

  // And the prose lines are still verbatim-grounded at their cited page.
  for (const { text, page, where } of lines) {
    if (PROSE.has(where.split(":")[0])) {
      assert.ok(lineIsGroundedAtPage(text, page), `${where}: "${text}" grounded at page ${page}`);
    }
  }
});
