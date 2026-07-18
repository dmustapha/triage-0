// File: tests/unit/class-router.test.ts
// Structural guard for the Phase-2 semantic router (src/triage/class-router.ts). Model-free: it does NOT
// embed anything (that needs the SDK + the GTE model — covered by scripts/calibrate-router.ts). What it
// protects is the ARTIFACT integrity that silently drives routing: every emittable WHO class MUST have a
// descriptor prototype AND a symptom-group entry, with no extras and no blanks. Without this, adding a
// class to CLASSIFICATION_ENUM (or renaming one) but forgetting its prototype would make that class
// unroutable — with no error, just a case that never reaches it. This test fails the build instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASS_PROTOTYPES, CLASS_GROUP, OFF_DOMAIN_THRESHOLD } from "../../src/triage/class-router.js";
import { CLASSIFICATION_ENUM } from "../../src/triage/protocol-table.js";

/** Every class the model may emit, except the UNKNOWN abstain escape hatch (which has no descriptor). */
const ROUTABLE = CLASSIFICATION_ENUM.filter((c) => c !== "UNKNOWN");

test("every routable class has exactly one descriptor prototype", () => {
  for (const cls of ROUTABLE) {
    assert.ok(CLASS_PROTOTYPES[cls], `missing CLASS_PROTOTYPES descriptor for "${cls}"`);
    assert.ok(CLASS_PROTOTYPES[cls].trim().length >= 20, `descriptor for "${cls}" is too short to route on`);
  }
});

test("no orphan prototypes (every descriptor maps to a real enum class)", () => {
  const enumSet = new Set(CLASSIFICATION_ENUM);
  for (const cls of Object.keys(CLASS_PROTOTYPES)) {
    assert.ok(enumSet.has(cls), `CLASS_PROTOTYPES has "${cls}" which is not in CLASSIFICATION_ENUM`);
  }
  // The descriptor set must be exactly the routable classes — no missing, no extra.
  assert.equal(Object.keys(CLASS_PROTOTYPES).length, ROUTABLE.length, "prototype count != routable class count");
});

test("every routable class belongs to exactly one symptom group", () => {
  for (const cls of ROUTABLE) {
    assert.ok(CLASS_GROUP[cls], `class "${cls}" is not assigned to any symptom group (SYMPTOM_GROUPS)`);
  }
  for (const cls of Object.keys(CLASS_GROUP)) {
    assert.ok(ROUTABLE.includes(cls), `CLASS_GROUP has "${cls}" which is not a routable enum class`);
  }
});

test("off-domain threshold is in a sane calibrated range", () => {
  // Guards a fat-fingered override: outside this band the gate would abstain everything or nothing.
  assert.ok(OFF_DOMAIN_THRESHOLD > 0.5 && OFF_DOMAIN_THRESHOLD < 0.95, `OFF_DOMAIN_THRESHOLD=${OFF_DOMAIN_THRESHOLD} out of sane range`);
});
