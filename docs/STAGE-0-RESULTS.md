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
Oracle capacity was unavailable for 45 h, so the first cloud-CPU numbers come from a 2-core x86 Codespace. Not the A1 box; Ampere Altra cores are expected to be slower per core (roughly a third), so treat these as optimistic until section C exists.

**Reading rule (from the final review):** each case ran 3 times back-to-back. llama-server caches the *whole* prompt between identical calls, so runs 2–3 replay the cache and are faster than any real user's call. **"First-sight" (run 1) is the honest latency.** The earlier draft of this section reported the 24-row p50 (4.9 s); that flattered the result. Prefix caching of the fixed system prompt is still real and still production behaviour; full-prompt replay is not.

| run | backend | model | output shape | first-sight p50 | first-sight p95 | warm-repeat p50 | tok/s | top-1 | RSS |
|---|---|---|---|---|---|---|---|---|---|
| baseline | qvac (SDK 0.23) | medpsy-4b | 3 candidates + question id | 38,444 | 39,440 | 38,151 | 2.7 | **8/8** | 4.9 GB |
| baseline | qvac (SDK 0.23) | medpsy-1.7b | same | 15,899 | 17,442 | 15,837 | 5.9 | 5/8 | 2.4 GB |
| baseline | llamacpp (prefix cache) | medpsy-4b | same | 10,703 | 12,381 | 9,031 | 3.9 | **8/8** | 4.7 GB |
| baseline | llamacpp (prefix cache) | medpsy-1.7b | same | 6,926 | 7,161 | 6,314 | 8.6 | 5/8 | 2.2 GB |
| exp A | llamacpp | medpsy-4b | 2 candidates, compact JSON | 9,273 | 10,686 | 8,241 | 4.0 | 8/8 | |
| exp B (2 runs/case) | qvac, `kvCache: true` | medpsy-4b | 2 candidates, compact JSON | 41,522 | 47,594 | 41,641 | 2.6 | 8/8 | |
| **exp C** | **llamacpp** | **medpsy-4b** | **page ids + confidence only; question from catalogue** | **6,099** | **6,995** | 4,707 | 4.1 | **8/8** | 4.7 GB |

Raw CSVs and logs: `docs/bench/codespace-x86-2core/`. The 8 bench cases were used while tuning the prompt (the `unsure` cue line was added after watching the two decoys fail), so 8/8 is an in-sample number; `bench/cases.json` now carries 7 held-out cases (3 paraphrased emergencies, 4 decoys) that have **not** been run yet, and the harness scores a decoy as a hit only when the model itself answered `unsure` (`fallback_reason`), never on a timeout or parse error.

What the numbers say:
1. **MedPsy-4B is the router.** 8/8 on every run, including both decoys answered `unsure`. MedPsy-1.7B is 5/8 everywhere: it confuses the choking sentence with collapse and never says `unsure`, so it over-triages to the *wrong* page with high confidence. Speed cannot buy that back.
2. **On CPU the fixed prompt dominates.** ~490 prompt tokens cost ~25 s of the SDK's 38 s. llama-server reuses the cached prefix between calls; the SDK does not, and its `kvCache` option made no difference (exp B). On CPU, **llama-server is the primary backend and the SDK is the fallback**, the reverse of the plan's default. Both sit behind the same `RouteBackend` contract, so this is a config change (`BACKEND=llamacpp`), now the default. Consequence: the SDK path has still never run on ARM; that proof moves to section C.
3. **Output tokens are the next cost.** Dropping the model-chosen question id (exp C) took first-sight p50 from 9.3 s to 6.1 s. The catalogue now supplies the next question deterministically (first unanswered red-flag question of the top page).

**Decision (provisional; budget NOT yet met on any hardware):** MedPsy-4B, llama-server with prefix cache, exp-C output shape, free CPU. First-sight p50 **6.1 s vs a 6 s budget** (borderline miss), p95 7.0 s ≤ 10 s, hit rate 8/8 in-sample. Nothing else is close: the 1.7B fails on correctness, the SDK path is 6× slower. The decision stands on direction, not on a passed gate. Levers still to measure on the box, in order: (a) trim the cue lists in the system prompt (fewer prefix tokens also means a smaller cache miss on the first call of a session), (b) a Q4_0 quant for ARM i8mm kernels, (c) thread count = `nproc`; if first-sight p50 on Ampere is still above ~8 s after those, rule 3 (paid shape) reopens.

Spec note for Dami: the LLM contract in the design doc (§3/§8) said the model picks page ids *and* a question id. Exp C removes the question id from the model's output; the catalogue asks the top page's questions in order and does not move to candidate 2 when they are exhausted. Flagged as a ruling for §20; reversible by restoring `next_question_id` to `buildOutputSchema`.

## C. Oracle A1 box (pending capacity; catcher workflow running)
**Precondition:** the catcher launches at 1 OCPU / 6 GB because that lands more easily; before benchmarking, resize the instance in place to 2 OCPU / 12 GB (`oci compute instance update --instance-id <id> --shape-config '{"ocpus":2,"memoryInGBs":12}'`, then reboot) so section C is comparable to section B. Units read `nproc`, so a 1-core run would be reported as such.
_Filled by `scripts/bench.ts` on the box (first-sight and held-out columns)._
