import { z } from "zod";
import { allQuestions, routablePageIds, type Catalog } from "../catalog.js";
import { CONFIDENCE } from "../contract.js";

/** Sentinel the model may pick when the text is not an emergency or cannot be placed. Maps to the holding page. */
export const UNSURE = "unsure";

/** JSON schema handed to the backend's constrained decoder. */
export function buildOutputSchema(catalog: Catalog): object {
  const pageIds = [...routablePageIds(catalog), UNSURE];
  const questionIds = allQuestions(catalog).map((q) => q.id);
  return {
    type: "object",
    properties: {
      candidates: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: pageIds } },
      next_question_id: { anyOf: [{ type: "string", enum: questionIds }, { type: "null" }] },
      confidence: { type: "string", enum: [...CONFIDENCE] },
    },
    required: ["candidates", "next_question_id", "confidence"],
    additionalProperties: false,
  };
}

/** Same enums as zod, so a backend that ignored the grammar is still caught. */
export function buildOutputValidator(catalog: Catalog) {
  const pageIds = [...routablePageIds(catalog), UNSURE] as unknown as [string, ...string[]];
  const questionIds = allQuestions(catalog).map((q) => q.id) as [string, ...string[]];
  return z.object({
    candidates: z.array(z.enum(pageIds)).min(1).max(3),
    next_question_id: z.enum(questionIds).nullable(),
    confidence: z.enum(CONFIDENCE),
  }).strict();
}
export type ModelOutput = z.infer<ReturnType<typeof buildOutputValidator>>;
