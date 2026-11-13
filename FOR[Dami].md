# FOR[Dami] — Triage-0 v1

## What changed today (2026-11-10)
The hackathon app (v0) moved whole into `archive/v0/`, frozen at tag `v0.2.0-hackathon`. The root is now the home of v1: an emergency first-response guide where the model only routes to pages we wrote. A clean root means the new service, the content catalogue and the infra scripts are not tangled with code that will never ship.

## Vocabulary
- **Reason-and-redirect** — the model picks labels (page ids, question ids) from a list we authored; a fixed table turns each label into the words the person sees. "The model routes; the pages carry the content."
- **Schema-constrained output** — the model is forced, token by token, to emit JSON that matches a schema we hand it. It cannot invent a field or a page id.
- **Fail-safe upward** — any doubt (low confidence, parse error, timeout) resolves to the holding page that says call for help. The only allowed error is over-triage.
- **Inference service** — the small HTTP server on the Oracle box that loads the model and answers `POST /route`.
- **Reverse proxy** — Caddy sits in front of the service, terminates HTTPS, and forwards to Node on localhost.
- **NSG (network security group)** — Oracle's per-instance firewall list; ours opens only 22, 80 and 443.

## How to run (local, no model needed for tests)
```bash
npm install                      # root; installs the service workspace
npm test                         # 47 tests: contract, router, lock, both backends, injection, hardening
npm run typecheck
CORS_ORIGINS=http://localhost:5173 npm run start --workspace service   # boots on 127.0.0.1:3020 with the real SDK
npm run spike:qvac --workspace service                                  # downloads MedPsy-1.7B (~1 GB) and routes one case
```
`POST /route` with `{"text":"she is coughing and cannot speak"}` returns ranked page ids, one next question, a confidence, and `fallback`. The page titles live in `service/catalog/stage0.json`; the model never writes a word the person sees.

## What the mid-point review caught (2026-11-10)
A fresh reviewer read the service before anything touched Oracle. The one critical find: when a model stalls and our 20 s timer fires, we released the lock but never told the SDK to stop, so the next person's request would have queued behind a ghost. Fixed by cancelling the run by its request id. Also fixed: the timer now starts when you join the queue, not when your turn comes; the `answers` field is bounded so it cannot carry smuggled instructions past the fence; odd client errors keep their 4xx status instead of becoming "something went wrong".

## What Stage 0 proved (2026-11-12, provisional on Ampere)
Measured on a free 2-core x86 cloud machine, same core count as the Oracle target. "First-sight" = the first time the model sees a sentence; repeat runs replay a cache and flatter the number (the final review caught this):

| | MedPsy-4B | MedPsy-1.7B |
|---|---|---|
| first-sight p50 per route call, llama-server, final output shape | **6.1 s** (budget 6 s) | 6.9 s (older shape) |
| p50 via the QVAC SDK (no prompt cache) | 38 s | 16 s |
| top-1 hit rate on 8 bench cases (6 emergencies + 2 decoys) | **8/8** | 5/8 |
| resident memory | 4.7 GB | 2.2 GB |

Decision in one sentence: **MedPsy-4B, served by llama.cpp with the fixed prompt cached, answering only with page ids and a confidence word, on free CPU**, provisional: the 6 s budget is a borderline miss on x86 and not yet measured on Ampere; three levers remain (shorter prompt, ARM-tuned quant, threads) before anything paid.

Why the SDK lost on CPU: it re-reads the 490-token fixed prompt every call; llama-server keeps it. The SDK stays as the fallback behind the same contract.

## How to run
```bash
npm test && npm run typecheck                     # 52 tests
npm run spike:qvac --workspace service            # one real SDK call on the Mac
service/scripts/oracle/deploy.sh <ip>             # deploy to the box (BACKEND=llamacpp default)
npm run bench --workspace service                 # on the box: BENCH_COMBOS="llamacpp:medpsy-4b"
```
