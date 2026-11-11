# Stage 0 results

Budget, fixed before any number was read: for one `POST /route` call on the Oracle A1 box, **p50 total ≤ 6 s, p95 total ≤ 10 s, top-1 hit rate ≥ 7/8** on `service/bench/cases.json`. Decision rule, in order: MedPsy-4B on free CPU → MedPsy-1.7B on free CPU → a paid shape.

## A. Mac dry run (2026-11-11, Apple Silicon, NOT the decision)
Purpose: prove the harness and both backends end to end before the box exists. Numbers here do not count toward the decision; the box has 2 slow cores and no GPU.

| backend | model | p50 total ms | p95 total ms | top-1 hit rate | notes |
|---|---|---|---|---|---|
| qvac (SDK 0.23) | medpsy-1.7b | 397 | 502 | 5/8 | solo run; misses: choking→severe_bleeding, both decoys→severe_bleeding |
| qvac (SDK 0.23) | medpsy-1.7b | 1043 | 2649 | 5/8 | after "unsure" sentinel + cue line; misses: choking→collapse_cpr, decoys→bleeding/anaphylaxis (both models resident, so slower) |
| llamacpp (llama-server 0.9.0) | medpsy-1.7b | 2260 | 5434 | 5/8 | same three misses as the SDK run → fallback path is consistent |

Findings that changed code:
1. **Thinking model.** MedPsy spends the whole token budget inside `<think>` under llama-server's chat template, returning empty content. Fixed with `chat_template_kwargs.enable_thinking=false` + `reasoning_budget: 0` on the request and `--reasoning-budget 0` on the unit. The SDK path never showed this.
2. **No way to say "not an emergency".** The schema forced 1..3 page ids, so decoys came back as a page with high confidence. Added the `unsure` sentinel (maps to fallback). The 1.7B still does not use it; that is a capability question for the 4B on the box.
3. **Duplicate candidates** appeared live; now de-duplicated.
4. Log hygiene held: 0 occurrences of the case text in the service log across all runs, including the error path.

Open lever if the 4B also ignores `unsure`: move the emergency/non-emergency decision to a leading boolean field in the output object (small models answer early fields more reliably than a label buried in a list).

## B. Oracle A1 box (pending capacity)
_Filled by `scripts/bench.ts` on the box._
