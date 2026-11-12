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

## B. GitHub Codespace, 2 vCPU x86 (AMD EPYC class), 8 GB, 2026-11-12
Oracle capacity was unavailable for 36 h, so the first cloud-CPU numbers come from a 2-core x86 Codespace. Not the A1 box, but the same core count; Ampere Altra cores are expected to be somewhat slower per core, so treat these as optimistic by roughly a third until section C exists.

| run | backend | model | output shape | p50 total ms | p95 total ms | tok/s | top-1 | RSS |
|---|---|---|---|---|---|---|---|---|
| baseline | qvac (SDK 0.23) | medpsy-4b | 3 candidates + question id | 38,362 | 39,321 | 2.7 | **8/8** | 4.9 GB |
| baseline | qvac (SDK 0.23) | medpsy-1.7b | same | 15,837 | 17,450 | 5.9 | 5/8 | 2.4 GB |
| baseline | llamacpp (prompt cache) | medpsy-4b | same | 9,066 | 12,021 | 3.9 | **8/8** | 4.7 GB |
| baseline | llamacpp (prompt cache) | medpsy-1.7b | same | 6,328 | 7,053 | 8.6 | 5/8 | 2.2 GB |
| exp A | llamacpp | medpsy-4b | 2 candidates, compact JSON | 8,478 | 10,242 | 4.0 | 8/8 | |
| exp B | qvac, `kvCache: true` | medpsy-4b | 2 candidates, compact JSON | 41,522 | 47,594 | 2.6 | 8/8 | |
| **exp C** | **llamacpp** | **medpsy-4b** | **page ids + confidence only; question from catalogue** | **4,911** | **6,793** | 4.1 | **8/8** | 4.7 GB |

Raw CSVs and logs: `docs/bench/codespace-x86-2core/`.

What the numbers say:
1. **MedPsy-4B is the router.** 8/8 on every run, including both decoys answered `unsure`. MedPsy-1.7B is 5/8 everywhere: it confuses the choking sentence with collapse and never says `unsure`, so it over-triages to the *wrong* page with high confidence. Speed cannot buy that back.
2. **On CPU the fixed prompt dominates.** ~490 prompt tokens cost ~25 s of the SDK's 38 s. llama-server reuses the cached prefix between calls; the SDK does not, and its `kvCache` option made no difference (exp B). On CPU, **llama-server is the primary backend and the SDK is the fallback**, the reverse of the plan's default. Both sit behind the same `RouteBackend` contract, so this is a config change (`BACKEND=llamacpp`), now the default.
3. **Output tokens are the next cost.** Dropping the model-chosen question id (exp C) took the 4B from 8.5 s to 4.9 s. The catalogue now supplies the next question deterministically (first unanswered red-flag question of the top page), which also tightens the "model routes, pages carry content" rule: the model's whole vocabulary is now page ids plus a confidence word.

**Decision (rule 1 of the budget, met on x86):** MedPsy-4B, llama-server with prompt cache, exp-C output shape, free 2-core CPU. p50 4.9 s ≤ 6 s, p95 6.8 s ≤ 10 s, hit rate 8/8 ≥ 7/8. **Provisional until section C** (the same bench on the A1 box). If the Altra cores land p50 between 6 and 8 s, the remaining levers are, in order: a Q4_0 quant for ARM i8mm kernels, trimming the cue lists in the prompt, and `-t 2` thread pinning; if still over, the 4B stays and the decision moves to a paid shape per rule 3.

Spec note for Dami: the LLM contract in the design doc (§3) said the model picks page ids *and* a question id. Exp C removes the question id from the model's output. Flagged as a ruling; reversible by restoring `next_question_id` to `buildOutputSchema`.

## C. Oracle A1 box (pending capacity; catcher workflow running)
_Filled by `scripts/bench.ts` on the box._
