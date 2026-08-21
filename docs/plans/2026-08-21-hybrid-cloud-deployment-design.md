# Triage-0 Hybrid Cloud Deployment Design

Date: 2026-08-21
Status: Approved

## Objective

Ship one product with two explicit runtimes:

1. **Local mode:** the existing Express and QVAC stack runs entirely on the user's device.
2. **Cloud mode:** the same public interface runs on Vercel and calls an isolated QVAC inference service on a dedicated EC2 instance.

HydraCut remains untouched on its existing instance.

## Architecture

```text
Local browser -> local Express/QVAC runtime

Public browser -> Vercel static frontend -> HTTPS -> dedicated Triage-0 EC2
                                                   -> Express/QVAC runtime
                                                   -> local model and RAG volumes
```

The frontend determines its mode from deployment configuration, never from marketing copy. Local mode uses same-origin endpoints. Cloud mode uses a configured HTTPS API origin. Each screen labels the active mode accurately.

## Components

- **Vercel frontend:** existing landing page and app interface, static assets, public product URL, Orynth verification file.
- **Triage-0 EC2:** Ubuntu 22.04+, QVAC-supported Linux architecture, persistent model cache, RAG store, application process, HTTPS reverse proxy, and system service.
- **Local runtime:** existing installation and offline behavior remain available without depending on cloud services.
- **Repository:** one codebase with environment-driven endpoint selection and mode-specific privacy language.

The EC2 size is selected only after current pricing, quota, and performance checks. The user must see the expected hourly and monthly cost before provisioning.

## Data Flow

In cloud mode, the browser sends case text or audio directly to the dedicated HTTPS backend. The backend runs the same retrieval, classification, deterministic protocol mapping, and speech pipeline, then streams the response to the browser. Cloud sessions are not described as zero-egress or on-device.

In local mode, requests remain on the same device and retain the existing zero-egress proof.

## Security and Clinical Boundaries

- Separate EC2 instance, security group, process, storage, logs, and deployment identity from HydraCut.
- HTTPS only for public traffic.
- Restrictive CORS for the Vercel production origin.
- Request-size limits, concurrency control, timeouts, rate limiting, and sanitized errors.
- No persistent storage of patient case text or audio by default.
- Mode-specific disclosure, research/education disclaimer, and no diagnostic or emergency-service claims.
- Public health checks reveal operational state without exposing secrets or patient data.

## Failure Handling

The Vercel interface detects backend unavailability and shows a clear cloud-runtime message with links to the local installation and demo. It must never silently substitute fabricated clinical output. Backend failures remain fail-closed, and unsupported cases continue to abstain.

## Deployment

1. Run local typecheck and tests.
2. Provision a dedicated EC2 instance after the cost gate.
3. Install and validate QVAC on Linux before exposing traffic.
4. Deploy the backend behind HTTPS and verify health, inference, speech, grounding, and abstention.
5. Configure and deploy the Vercel frontend.
6. Run desktop/mobile, API, privacy-copy, and end-to-end checks.
7. Add the Orynth ownership token to the Vercel deployment and verify the public file exactly.

## Acceptance Criteria

- HydraCut is not modified or restarted.
- Local Triage-0 remains functional.
- The Vercel URL renders landing and app pages.
- A cloud test case returns a real QVAC-backed, WHO-cited result.
- Cloud mode never claims on-device or zero-egress behavior.
- Local mode retains its verified offline claims.
- Public endpoints use HTTPS and enforce the defined safety controls.
- Orynth can verify ownership through the Vercel domain.

