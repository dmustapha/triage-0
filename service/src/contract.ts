import { z } from "zod";

export const AGE_BANDS = ["baby", "child", "adult", "pregnant", "older_adult"] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;
export const BACKENDS = ["qvac", "llamacpp"] as const;
export const MODELS = ["medpsy-4b", "medpsy-1.7b"] as const;
/** Why a response fell back to the holding page. Diagnostic only; never carries case text. */
export const FALLBACK_REASONS = ["unsure", "low_confidence", "parse_error", "schema_invalid", "timeout", "queue_full", "backend_error"] as const;

export const RouteRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((s) => /[\p{L}\p{N}]/u.test(s), "text must contain a letter or digit"),
  age_band: z.enum(AGE_BANDS).optional(),
  answers: z
    .array(z.object({ question_id: z.string().regex(/^[a-z0-9_]{1,64}$/), answer: z.enum(["yes", "no", "unsure"]) }))
    .max(20)
    .optional(),
});
export type RouteRequest = z.infer<typeof RouteRequestSchema>;

export const RouteResponseSchema = z.object({
  candidates: z.array(z.object({ page_id: z.string(), rank: z.number().int().min(1) })),
  next_question: z.object({ id: z.string(), text: z.string() }).nullable(),
  confidence: z.enum(CONFIDENCE),
  fallback: z.boolean(),
  fallback_reason: z.enum(FALLBACK_REASONS).optional(),
  timing: z.object({
    ttft_ms: z.number().nullable(),
    total_ms: z.number(),
    tokens_per_s: z.number().nullable(),
  }),
  backend: z.enum(BACKENDS),
  model: z.enum(MODELS),
});
export type RouteResponse = z.infer<typeof RouteResponseSchema>;
