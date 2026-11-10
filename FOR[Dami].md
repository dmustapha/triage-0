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

## How to run
Filled in Task 3.
