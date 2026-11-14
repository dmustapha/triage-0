import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const QuestionSchema = z.object({ id: z.string().min(1), text: z.string().min(1) });
const PageSchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  title_plain: z.string().min(1),
  cues: z.array(z.string()),
  red_flag_questions: z.array(QuestionSchema),
});
const CatalogSchema = z.object({ holding_page_id: z.literal("holding"), pages: z.array(PageSchema).min(1) });

export type Question = z.infer<typeof QuestionSchema>;
export type Page = z.infer<typeof PageSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

export const STAGE0_PATH = fileURLToPath(new URL("../catalog/stage0.json", import.meta.url));

export function loadCatalog(path: string): Catalog {
  const c = CatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const pageIds = new Set<string>();
  const qIds = new Set<string>();
  for (const p of c.pages) {
    if (pageIds.has(p.id)) throw new Error(`catalog: duplicate page id ${p.id}`);
    pageIds.add(p.id);
    for (const q of p.red_flag_questions) {
      if (qIds.has(q.id)) throw new Error(`catalog: duplicate question id ${q.id}`);
      qIds.add(q.id);
    }
  }
  if (!pageIds.has(c.holding_page_id)) throw new Error("catalog: holding page missing");
  return c;
}

export function routablePageIds(c: Catalog): string[] {
  return c.pages.filter((p) => p.id !== c.holding_page_id).map((p) => p.id);
}

export function allQuestions(c: Catalog): Question[] {
  return c.pages.flatMap((p) => p.red_flag_questions);
}
