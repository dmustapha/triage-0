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
import { PROTOCOL_TABLE, CLASSIFICATION_ENUM, reconcileMalaria, reconcileDiarrhoea, type GroundedLine } from "../../src/triage/protocol-table.js";

const mapPath = config.citationMapPath;
const skip = existsSync(mapPath) ? false : "citation-map.json not present — run `npm run ingest` first";

type MapEntry = { protocol: string; title: string; page: number; section: string; content: string };
const CMAP: Record<string, MapEntry> = skip ? {} : JSON.parse(readFileSync(mapPath, "utf8"));

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Is `text` a verbatim (ws-normalised, case-insensitive) substring of SOME chunk at `page`? */
function groundedAtPage(text: string, page: number): boolean {
  const needle = norm(text);
  if (!needle) return false;
  return Object.values(CMAP).some((c) => c.page === page && norm(c.content).includes(needle));
}

function pageExists(page: number): boolean {
  return Object.values(CMAP).some((c) => c.page === page);
}

test("dose-safety gate: every protocol-table line is verbatim-grounded at its cited page", { skip }, () => {
  for (const [cls, e] of Object.entries(PROTOCOL_TABLE)) {
    const proseLines: GroundedLine[] = [
      e.action,
      e.citation,
      ...e.supportive,
      ...e.home_care,
      ...e.return_now,
      ...(e.follow_up ? [e.follow_up] : []),
      ...(e.referral ? [e.referral] : []),
    ];
    for (const ln of proseLines) {
      assert.ok(
        groundedAtPage(ln.text, ln.page),
        `${cls}: "${ln.text}" is NOT a verbatim substring of any chunk on page ${ln.page}`,
      );
    }
    // Medicines: `dose` (when present) is ALWAYS the non-numeric banded marker (never a fabricated
    // amount); `frequency` (when present) is verbatim at the dosing page; the cited page must exist.
    for (const med of e.medicines) {
      assert.ok(pageExists(med.page), `${cls}: medicine ${med.name} cites a page (${med.page}) that exists in the corpus`);
      if (med.dose !== undefined) {
        assert.equal(med.dose, "By weight band", `${cls}: medicine ${med.name} dose must be banded guidance, not a number (got "${med.dose}")`);
      }
      if (med.frequency !== undefined) {
        assert.ok(
          groundedAtPage(med.frequency, med.page),
          `${cls}: medicine ${med.name} frequency "${med.frequency}" is NOT verbatim on page ${med.page}`,
        );
      }
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
