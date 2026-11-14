import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalog, STAGE0_PATH } from "../../src/catalog.js";

test("stage0 catalogue has the six life-savers plus holding, each with two stub questions", () => {
  const c = loadCatalog(STAGE0_PATH);
  assert.deepEqual(c.pages.map((p) => p.id).sort(), ["anaphylaxis", "choking", "collapse_cpr", "holding", "seizure", "severe_bleeding", "stroke"]);
  for (const p of c.pages) if (p.id !== "holding") assert.equal(p.red_flag_questions.length, 2);
  assert.equal(c.holding_page_id, "holding");
});

test("loadCatalog rejects duplicate question ids across pages", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const bad = {
    holding_page_id: "holding",
    pages: [
      { id: "a", title_plain: "A", cues: [], red_flag_questions: [{ id: "dup", text: "x" }] },
      { id: "b", title_plain: "B", cues: [], red_flag_questions: [{ id: "dup", text: "y" }] },
      { id: "holding", title_plain: "H", cues: [], red_flag_questions: [] },
    ],
  };
  const p = join(dir, "bad.json");
  writeFileSync(p, JSON.stringify(bad));
  assert.throws(() => loadCatalog(p), /duplicate question id/);
});
