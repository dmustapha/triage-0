import type { RouteRequest, RouteResponse } from "../contract.js";
import type { Catalog } from "../catalog.js";
import type { RouteBackend } from "../backends/types.js";
import { buildPrompt } from "./prompt.js";
import { buildOutputSchema, buildOutputValidator, UNSURE } from "./schema.js";
import type { InferenceLock } from "./lock.js";
import { log } from "../log.js";

export const MAX_TOKENS = 160;

export type RouteDeps = { backend: RouteBackend; catalog: Catalog; timeoutMs: number; lock: InferenceLock };

type Timing = RouteResponse["timing"];

function fallbackResponse(deps: RouteDeps, timing: Timing, reason: string): RouteResponse {
  log.warn("route_fallback", { route: reason, backend: deps.backend.name, model: deps.backend.model });
  return {
    candidates: [], next_question: null, confidence: "low", fallback: true,
    timing, backend: deps.backend.name, model: deps.backend.model,
  };
}

/** The only place that decides `fallback`. Any doubt resolves upward to the holding page. */
export async function routeCase(req: RouteRequest, deps: RouteDeps): Promise<RouteResponse> {
  const t0 = performance.now();
  const timing = (): Timing => ({ ttft_ms: null, total_ms: Math.round(performance.now() - t0), tokens_per_s: null });
  const { system, user } = buildPrompt(req, deps.catalog);
  const jsonSchema = buildOutputSchema(deps.catalog);

  let raw;
  try {
    raw = await deps.lock.run(
      (signal) => deps.backend.complete({ system, user, jsonSchema, maxTokens: MAX_TOKENS, signal }),
      deps.timeoutMs,
    );
  } catch (err) {
    return fallbackResponse(deps, timing(), (err as Error).name || "backend_error");
  }
  const t: Timing = { ttft_ms: raw.ttftMs, total_ms: raw.totalMs, tokens_per_s: raw.tokensPerS };

  let parsed: unknown;
  try { parsed = JSON.parse(raw.text); } catch { return fallbackResponse(deps, t, "parse_error"); }
  const v = buildOutputValidator(deps.catalog).safeParse(parsed);
  if (!v.success) return fallbackResponse(deps, t, "schema_invalid");
  if (v.data.confidence === "low") return fallbackResponse(deps, t, "low_confidence");
  if (v.data.candidates.includes(UNSURE)) return fallbackResponse(deps, t, "unsure");
  const pageIds = [...new Set(v.data.candidates)];

  // The model names pages; the catalogue supplies the next question (first unanswered red-flag question of the top page).
  const answered = new Set((req.answers ?? []).map((a) => a.question_id));
  const topPage = deps.catalog.pages.find((p) => p.id === pageIds[0]);
  const question = topPage?.red_flag_questions.find((q) => !answered.has(q.id)) ?? null;
  return {
    candidates: pageIds.map((page_id, i) => ({ page_id, rank: i + 1 })),
    next_question: question ? { id: question.id, text: question.text } : null,
    confidence: v.data.confidence,
    fallback: false,
    timing: t,
    backend: deps.backend.name,
    model: deps.backend.model,
  };
}
