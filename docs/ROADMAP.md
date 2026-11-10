# Triage-0 — the complete road: every capability, every stage, the ship gate, and after

Design source: `docs/superpowers/specs/2026-11-09-triage-0-v1-production-design.md` (approved 2026-11-10).
Audited 2026-11-10 against the full deliberation transcript. Part A lists **every capability we have
agreed to build** and the stage it lands in, so nothing is hidden inside a stage name. Part B is the
stage-by-stage sequence with exit tests. Part C is what comes after the ship gate. Part D is what has
deliberately **not** been decided yet, so a missing item is a known gap, not a forgotten one.

---

## Part A — Capability inventory (what the finished v1 does)

### A1. The front door (home screen, structure + voice settled; look not yet designed)
| # | Capability | Stage |
|---|---|---|
| 1 | Calm opening: "What's happening? I'm here to help. Talk, type, or tap. You don't need the right words." | 1 |
| 2 | Talk box with microphone (speech-to-text) and typing | 1 |
| 3 | Four big instant buttons: Not breathing / collapsed · Choking · Bleeding a lot · Having a fit (seizure). One tap, zero questions, zero AI, works offline | 1 |
| 4 | "It's me — I feel very unwell" quiet entry (user is the patient) | 1 |
| 5 | Ambulance bar on every screen, dialling the **local** emergency number | 1 |
| 6 | Offline fallback: a browsable plain-language list of presentations when there is no network | 1 |
| 7 | Mental-health crisis reachable as its own presentation (suicidal person, acute agitation) | 1 (engine) / 3 (pages) |

### A2. Engine behaviours (built once, apply to every emergency)
| ID | Capability | Stage |
|---|---|---|
| E1 | Scene safety: "is it safe for you?" before acting (fire, traffic, electricity, water, violence, gas) | 1 |
| E2 | Two-step breathing gate: "Are they awake / responding?" → if no, "Are they breathing?" → CPR page or recovery-position page. "Not sure" always takes the more urgent branch. First life-saving action shown **while** they answer | 1 |
| E3 | Fail-safe upward: any uncertainty, no answer, low model confidence → more urgent action, never less | 1 |
| E4 | Who's affected (you / someone else) + age band (baby · child · adult · pregnant · older adult), one tap, skippable, defaults to adult | 1 |
| E5 | The clock: app keeps time (onset, seizure length, CPR cycles, when adrenaline was given); pages declare what to time | 1 |
| E6 | Tone + voice + hands-free + big text: calm "we" copy; every step readable aloud (text-to-speech); operable by voice; thumb-sized targets; one idea per screen | 1 |
| E7 | Local emergency number: bundled per-country table with regional variants, auto-detected from phone region, one-tap override, 112 fallback, each row sourced and dated | 1 |
| E8 | Responder toggle "I'm a health worker": self-declared, no verification, progressively reveals the trained tier with cited doses | 1 |
| E9 | Offline core: installable web app; the engine and **every page** cached; instant lane and all pages work with no signal | 1 |
| E10 | Universal "We're not sure yet" holding page (call now, keep still and warm, watch breathing, nothing by mouth, what to tell the medic) | 1 (built) / Dami signs in 1 |
| E11 | Known-conditions question: asthma · diabetes · heart/BP · epilepsy · sickle cell · pregnancy · allergies · blood thinners · **I don't know**; never a gate; only raises urgency or opens a branch; goes into hand-off | 1 |
| E12 | Nearest hospital: button opens the phone's own maps app searched for hospital / emergency near the user; "pick one with an emergency unit"; no location stored; no in-app ranking | 1 |

### A3. The conversation lane (the AI, confined to routing)
| # | Capability | Stage |
|---|---|---|
| 1 | Say or type what's happening in your own words | 1 |
| 2 | Model routes to candidate pages; asks **only** red-flag questions that change urgency or page; at most ~3 before provisional guidance; keeps refining | 1 |
| 3 | Questions are **pre-authored and signed** per page; the AI only picks which to ask next | 1 (engine) / 2–3 (content) |
| 4 | Streams; provisional action appears immediately; shows the holding page while waiting | 1 |
| 5 | Calm, short AI turns: acknowledge → one question or one instruction; plain words; never "you have X" | 1 |
| 6 | Reason-and-redirect: model picks labels; a signed table supplies every action, dose, urgency, citation | 0–1 |
| 7 | Prompt-injection fencing: user text can never change an action | 1 |
| 8 | Speech through our own service by default (Whisper in, Supertonic out); phone speech only when on-device or with consent | 0–1 |
| 9 | Model: MedPsy-4B by default, 1.7B or GPU shape if too slow; swappable | 0 |

### A4. Every emergency page (the template, authored ~90–100 times)
| Field | Capability | Stage |
|---|---|---|
| 0 | Plain title ("Bleeding a lot") + clinical title for the health-worker tier and hand-off | 2–3 |
| 1 | Recognition: plain picture + confirming red flags, written as "this could be…" | 2–3 |
| 1b | Pre-authored red-flag questions for the conversation lane | 2–3 |
| 1c | Which known conditions matter here and what they unlock | 2–3 |
| 2 | Urgency verdict (v1: always emergency now) | 2–3 |
| 3 | Get help: local number + maps hand-off | 2–3 |
| 4 | Do this now, responder-tiered (Anyone / Health worker with cited doses), with **"if no better → next"** branches and **equipment branches** (AED, adrenaline pen, tourniquet, inhaler, glucose, naloxone) | 2–3 |
| 5 | Do NOT | 2–3 |
| 6 | While you wait: what to watch, what the clock times | 2–3 |
| 7 | Hand-off: what to tell the medic (onset time from the clock, what happened, what was done/given, known conditions) | 2–3 |
| 8 | If it gets worse: safety-netting | 2–3 |
| 9 | Even if they seem fine: when they still must be seen | 2–3 |
| 10 | Source: the published guideline/text each line is grounded in, shown to the user | 2–3 |
| — | Dami's sign-off marker and date; unsigned pages cannot ship | 2–3 |

### A5. Content (the library)
| # | Capability | Stage |
|---|---|---|
| 1 | Six universal life-savers: collapse/CPR, choking, severe bleeding, anaphylaxis, seizure, stroke | 2 |
| 2 | Every immediate-life-threat condition across 20 body systems + paediatric branch (`docs/context/EMERGENCY-SCOPE-v1.md`, ~90–100 pages), signed per shelf | 3 |
| 3 | Per-page tests: schema-valid; every dose matches its cited source; no forbidden wording ("you have", "stay home"); urgency = emergency; hand-off present; at least one "anyone" step | 1 (harness) / 2–3 (run) |
| 4 | Authoring rule: facts from published sources, wording ours, every line cited, no branded instruments reproduced | 2–3 |
| 5 | Content licence for the authored pages (CC BY-SA 4.0 proposed) | 0 |
| 6 | Pages carry sign-off dates; re-reviewed when guidelines change; content shipped as versions | 3 onward |

### A6. Safety, privacy, legal
| # | Capability | Stage |
|---|---|---|
| 1 | No stay-home / self-care verdict exists anywhere in v1 code | 1 |
| 2 | Disclaimer on first open and in settings; terms of use; "not a substitute for emergency services" | 1 |
| 3 | No case text, audio or images kept beyond the session unless the user explicitly saves a hand-off summary | 1 |
| 4 | Service: HTTPS only, restrictive CORS, request-size limits, rate limiting, no logging of case content, health check exposes no data, no third-party calls during inference | 0–1 |
| 5 | Designed as a medical device from day one; v1's only possible error is over-triage | all |
| 6 | Legal counsel review before public launch (Nigeria first) | parallel, before gate |
| 7 | Written answer from Tether on MedPsy commercial use (not a build gate; before commercial launch) | parallel |
| 8 | Public repo, Apache-2.0 code; nothing confidential committed | 0 |

### A7. Platform and infrastructure
| # | Capability | Stage |
|---|---|---|
| 1 | Next.js progressive web app on Vercel, installable, Dami's domain | 1 (app) / parallel (domain) |
| 2 | Node + `@qvac/sdk` 0.23.x inference service on Oracle Cloud Ampere A1 (ARM); plain llama.cpp fallback behind the same contract | 0 |
| 3 | Frozen phone ↔ service contract (`POST /route`, streaming) | 0 |
| 4 | v0 preserved: tag, branch, archive folder | 0 |
| 5 | Accessibility: contrast, dynamic type, screen-reader labels, haptics | 1 |
| 6 | Device matrix: low-end Android + iPhone, tested on real phones | 1–3 |

### A8. Design (the look), docs, and launch material
| # | Capability | Stage |
|---|---|---|
| 1 | Low-fi wireframes: done (home screen, next beat, voice) | done |
| 2 | Visual design pass: 2–3 genuinely distinct directions rendered as real components on a phone; Dami picks palette and feel | parallel to 1–2 |
| 3 | High-fi screens applied to the engine; accessibility audit; copy read by non-medical people | 2 |
| 4 | README, landing page, pitch line ("tells you what to do in the minutes before help arrives…"), pitch deck / demo for "pitch everywhere" | before gate |
| 5 | `FOR[Dami].md` kept current (every mechanism explainable) | every stage |

---

## Part B — The stages before the ship gate

### Stage 0 — Foundations spike (days)
Build: A7.2–A7.4, A3.6, A3.8–A3.9, A5.5, A6.4 (service hardening basics), A6.8.
Dami: approves content licence.
**Decision made here, on measured numbers (Dami 2026-11-10):** stay on the free CPU box with 4B, drop to 1.7B, or pay for a GPU shape. Not decided before.
**Exit test:** a typed sentence from a phone browser returns ranked page ids + one next question from the Oracle box inside the latency budget; fallback proven once.

### Stage 1 — The engine, empty of medicine (weeks)
Build: A1 (all), A2 E1–E12, A3.1–A3.5 + A3.7, A5.3 harness, A6.1–A6.4, A7.1, A7.5.
Dami: writes and signs the holding page (E10).
**Exit test:** a fake page runs through both lanes, online and offline, on a real phone; holding page live.

### Stage 2 — Six universal life-savers (internal milestone)
Build/author: A5.1 on the A4 template, with red-flag questions, known-condition hooks, equipment branches. Apply A8.3.
Dami: signs six pages; watches non-medical people read them.
**Exit test:** Dami runs all six on his own phone and accepts voice and flow; per-page tests green.

### Stage 3 — Content sweep to the ship line
Build/author: A5.2 shelf by shelf; completeness audit per shelf against the scope file.
Dami: signs each shelf.
**Exit test = THE SHIP GATE (v1.0):**
1. Every v1 condition in `EMERGENCY-SCOPE-v1.md` has a signed, tested page.
2. Both lanes work online and offline on low-end Android and iPhone.
3. Legal counsel has reviewed posture, disclaimers and copy.
4. Emergency-number table reviewed; maps hand-off works on both platforms.
5. Visual design applied; accessibility audit passed.
6. Domain live on Vercel; service live and hardened on Oracle; no case data logged anywhere.
7. README, landing, pitch material ready.
→ **Ship v1.0. Start pitching.**

### Parallel tracks (start at Stage 1, must land before the gate)
Visual design pass (A8.2) · legal counsel (A6.6) · Oracle hardening + Vercel + domain (A7.1) · Tether letter (A6.7) · launch material (A8.4) · `FOR[Dami].md` (A8.5).

---

## Part C — After the ship gate

### Stage 3b — Clinical peer review (first thing after shipping; runs alongside Stage 4)
Other doctors test the shipped app and every page. Mechanism, so it produces evidence rather than opinions:
- A **reviewer mode** (unlocked by a link we send): every page shows a "Flag this page" button that captures page id, field, the reviewer's comment and their name/grade. Nothing about real cases is captured.
- A **review log** per page: who reviewed, when, what changed, which guideline settled it. Lives in the repo next to the page. This log is the clinical evidence file for counsel, ministries and later CE.
- Target: every v1 page read by at least one doctor other than Dami; the six life-savers by three. Disagreements resolved against the cited source; the page is re-signed with the new date.
- Invite list: Dami's colleagues (house officers, registrars, emergency physicians), and the pitch audience's own clinicians when a partner asks "who checked this?".
**Exit:** 100% of v1 pages peer-reviewed; open flags at zero; review log published in the repo.

### Stage 4 — v1.1 Images
Open photo upload any time; vision model **describes only** (snake features, wound size, medicine label via OCR); description enters the router as if typed; the four rules (describe never diagnose; can only raise urgency; unclear → ignored for de-escalation, ask for words; never "this is X"); optional prompted photos per page (burn: "bigger than their palm?"). Prove the multimodal addon on the Oracle box first.
**Exit:** a photo can raise or keep urgency, never lower it; tests prove the four rules.

### Stage 5 — v1.x Languages and voice depth
Local languages for the launch market (Dami names them; v0 had fr/es); translation addon; on-device speech where phones support it; every translated page re-signed.
**Exit:** a non-English speaker completes a page end to end.

### Stage 6 — v2 The urgent tier ("see a doctor today")
First version that can say "not an emergency now", so it brings: the down-triage confidence question; the formal device-classification decision (FDA CDS criteria, EU MDR Rule 11) with counsel; a wider clinical review loop than one author.
**Exit:** urgent-tier pages signed; regulatory path chosen and documented.

### Stage 7 — v3 The rest of medicine
Chronic and routine conditions by shelf, same engine and template; more clinical authors and a review board.

### Later, when earned
Native iOS/Android apps · partner distribution (ministries, NGOs, telcos, insurers, employers) and the business model (free to users, revenue from partners/grants) · public attribution of Dami as author · EU CE marking.

### Always
Content versioning with sign-off dates and guideline-change re-review; full test suite before every release; no case data stored.

---

## Part D — Not yet decided (known gaps, to settle when we reach them)
- Anonymous usage or crash reporting (none discussed; default is none, consistent with no case data).
- An in-app "something was wrong" feedback button for **users** (clinician feedback is now Stage 3b reviewer mode).
- How content updates reach installed offline copies (version check on open, silent refresh).
- Review cadence for pages and the emergency-number table (yearly? on guideline change?).
- Whether the hand-off summary can be shared (SMS/WhatsApp to the hospital) — out of v1.
