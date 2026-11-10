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
