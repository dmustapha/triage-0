# Triage-0 v1 — Product & System Design

**Status:** Draft for Dami's approval (builder-check pending)
**Date:** 2026-11-09
**Authors:** Dami Mustapha (product owner, clinical author — licensed MD, house officer) · Claude (design/engineering)
**Supersedes:** the hackathon-era app (v0.2.0, health-worker decision support, IMCI + mhGAP only)

> This document is written so a talented builder can plan and build v1 without coming back to Dami.
> Every decision below was deliberated and settled between 2026-11-06 and 2026-11-09. Decision
> provenance (who decided what) is in §17. The full deliberation trail is in
> `docs/context/2026-11-06-PRODUCTION-TRANSFORM-HANDOFF.md`.

---

## 1. Intent and why

Triage-0 v1 is an **emergency first-response guide**: it tells an ordinary person what to do in the
minutes before help arrives — calmly, step by step, in plain language, written by doctors — and it is
built so that it can **never tell someone to stay home when they shouldn't.**

It is **not** a symptom checker and **not** a diagnosis app. The published evidence indicts that
category: consumer symptom checkers gave appropriate triage in only 57% of standardized cases
(Semigran, BMJ 2015); five years later median triage accuracy was 55.8%, "not improved", with
emergency-detection sensitivity fallen from 85.7% to 51.9% and apps "missing >40% of emergencies"
(Schmieding, J Med Internet Res 2022); on real ED patients ChatGPT-3.5 gave unsafe (under-triage)
advice 41% of the time vs Ada's 14% (Fraser, JMIR mHealth 2023). All three verified from primary text.

**Why we can be different (the moat):**
1. **Reason-and-redirect architecture.** A purpose-built medical LLM (QVAC MedPsy) does exactly one
   job — understand the situation and route it to the right pre-written page. It never authors
   medicine, doses, or urgency. A trusted, deterministic content table supplies every instruction.
2. **Clinician-authored, cited content.** Every page is written against published sources and signed
   off by a licensed doctor before it ships.
3. **Structural safety.** v1's scope (immediate life-threats only) means every output is "do this now
   + get help now." The app has no stay-home verdict, so the one error that kills — under-triage —
   cannot occur in v1 by construction.

**Who it's for:** ordinary people in an emergency (primary), and health workers / nurses who are first
on scene (second rung), up to the moment a doctor or ambulance takes over.

**Why now:** the first build (QVAC hackathon) proved the deterministic-grounding pattern on a 1.7B model;
QVAC's stack has since shipped the three capabilities the consumer vision needs (a stronger medical
model, multimodal/OCR, tool-calling/multi-turn); and the regulatory and evidence landscape now clearly
favours a product that is honest about being triage, not diagnosis.

---

## 2. Goals, non-goals, anti-goals

**Goals (v1 must):**
- Cover the complete **immediate life-threat tier** across all body systems and all ages (~90–100
  conditions; see `docs/context/EMERGENCY-SCOPE-v1.md`).
- Get a frightened layperson from "something is wrong" to the first life-saving action in **seconds**,
  with **zero** dependency on network or AI for the catastrophic cases.
- Guide them step by step until hand-off to a doctor/ambulance, including what to do while waiting
  and what to tell the medic.
- Serve a health worker on scene with a deeper tier of actions (with cited doses) via one toggle.
- Be fully autonomous at runtime: no human in the loop once a user opens it.
- Ship as a PWA that works on any phone and keeps its life-saving core available offline.
- Be legally and clinically defensible: every instruction traceable to a published source;
  always-escalate posture; no stored health data.

**Non-goals (v1 does not):**
- Diagnose. Name a disease as fact. Issue probabilities.
- Cover urgent-but-not-immediate ("see a doctor today") or chronic conditions — those are v2/v3.
- Issue any "stay home / you're fine" verdict.
- Rank, verify or recommend facilities, give directions, or arrange transport. The disposition is
  "call the emergency number or get to the nearest hospital now", with the local number dialled (E7)
  and a hand-off to the phone's own maps app for "hospital near me" (E12). (Dami, 2026-11-10.)
- Verify a user's professional credentials.
- Replace emergency services or the clinician who arrives. The app stops at hand-off.
- Pursue CE marking / formal device classification (deferred to v2 decision point).
- Image input (v1.1, immediately after v1).

**Anti-goals (would make v1 a failure even if it "works"):**
- A single pathway in which the app could reassure a dying person. Under-triage is the unforgivable error.
- An LLM call sitting between a user and the first life-saving instruction.
- A page that reads as diagnosis ("you have X").
- A screen a panicking person has to *study*. Crowding is a hard fail.
- Medical wording the user doesn't know ("haemorrhage", "syncope") on the surface.
- Copying a branded triage instrument (ESI, MTS, WHO IITT, CTAS) — all confirmed commercially locked.

---

## 3. Standing principles (govern every design and wording decision)

1. **Triage, not diagnosis.** Output = *how urgent* + *what to do* + *where to go*. Never a disease
   label as fact. A named cause is always "possible/suspected" and exists only to convey seriousness
   and aid hand-off. The intake is red-flag screening for urgency, not history-taking.
2. **Fail safe, upward.** Under any uncertainty — unclear answer, no answer, ambiguous photo, model
   unsure — the app rounds **up** to the more urgent action. It never rounds down.
3. **Reason-and-redirect.** The LLM classifies/routes only. Content, doses, urgency come from the
   deterministic page table. (Carried from v0: "model picks the label; a trusted table supplies the answer.")
4. **Universal → engine; condition-specific → page.** Anything true for every emergency is built once
   in the engine. Anything that differs by condition lives in that condition's page. Never re-author
   universal safety logic per page.
5. **First action before first question.** Wherever possible the page gives the first life-saving
   action *while* the user answers a gate question. Never make them wait.
6. **Plain words, calm voice, "we".** See §10.
7. **The app's job ends at hand-off.** It never tries to be the doctor.

---

## 4. Users and the responder ladder

- **Anyone (default).** A layperson, often frightened, often one-handed, possibly in the dark or with
  poor literacy, possibly the patient themselves. Sees the simple layer only.
- **Health worker (toggle on).** A nurse / community health worker / trained first-aider on scene.
  Flipping one self-declared toggle ("I'm a health worker") progressively discloses the trained tier
  on every page: additional actions plus cited doses. **No credential verification** — it cannot be
  done from a phone and is unnecessary: the trained-tier content is standard published first-responder
  guidance; the layer exists to avoid overwhelming the bystander, not to gate secrets.
- **Hand-off.** When a doctor/ambulance arrives, the page's hand-off block tells the user what to say.
  Then the app stops. The health-worker tier is the original app's audience (CHWs), now the second rung.

**Who's affected** is asked once up front ("you, or someone else?") and branches wording
(self-administer vs administer-to-another).

---

## 5. Scope, content model, and the ship line

### 5.1 One engine, a growing library
The **app** is built once and does not change as medicine is added. The **content** is a library of
pages that grows forever. Adding a condition = writing one page on the fixed template (§7).

- **Library shelves = body systems** (the completeness backbone for authoring and audit; sign-off is
  per shelf). 20 systems + a paediatric age-branch that cross-cuts all of them. Enumerated in
  `docs/context/EMERGENCY-SCOPE-v1.md`.
- **Front desk = the intake** (§8), which takes "what's happening" (presentation / chief complaint)
  and routes to the right page. The user never navigates by system.
- Each condition is **one record** tagged with: primary system, the presentations it appears under,
  age/population branches, acuity. A page is reachable from any matching complaint; cross-listed
  conditions are a single page, not duplicates.

### 5.2 The ship line (sliced by acuity, never by system)
**v1 ships when every immediately-life-threatening condition ("call an ambulance now" tier) across all
systems and all ages has an authored, physician-signed, tested page.** Rationale: a half-covered
emergency app is dangerous — the gap is where someone dies. Covering one acuity tier completely is an
honest promise; covering some systems is not.

- **v1** = immediate life-threat tier, complete. (~90–100 pages.)
- **v2** = urgent-but-not-immediate tier ("see a doctor today/soon"). *This reintroduces down-triage
  verdicts and triggers the regulatory reassessment (§12).*
- **v3+** = chronic and everyday conditions ("adult med and the others"), on the same shelves.
- **v1.1** = image input (§11), immediately after v1 ships.

**Internal milestone before the full tier:** engine + six universal life-savers working end-to-end on
a phone — collapse/CPR, choking, severe bleeding, anaphylaxis, seizure, stroke. Prove the pattern, then
grind out the tier.

---

## 6. The engine — universal behaviours (built once)

| ID | Behaviour | Detail |
|----|-----------|--------|
| E1 | **Scene-safety check** | Before acting: "Are you / is it safe?" (electricity, fire, traffic, violence, gas, water). Rescuer must not become victim #2. |
| E2 | **Primary gate (two steps, DRS-ABC)** | First beat of **every** path, whatever was tapped or said. **Step 1: "Are they awake / responding to you?"** If YES → continue to the chosen page (a conscious person with breathing *difficulty* is handled by their page, e.g. asthma/anaphylaxis — they are **not** routed to CPR). If NO → **Step 2: "Are they breathing?"** Not breathing / not sure → **collapse/CPR page**; breathing → **recovery-position / unresponsive page**, then the chosen page's unconscious branch. "Not sure" always takes the more urgent branch (E3). Copy: "Not sure? Tap No — we'll check together. Nothing bad happens if you're wrong." **Accepted by Dami 2026-11-10 (no change requested).** |
| E3 | **Fail-safe routing** | Under any doubt (no answer, timeout, low model confidence, ambiguous input) round **up** to the more urgent disposition. Never down. |
| E4 | **Who's affected + age band** | Asked once, as one tap grid: "you, or someone else?" and the age band (**baby · child · adult · pregnant · older adult**). Skippable; defaults to adult; a wrong/unknown age never blocks the instant lane (fail-safe). Pages branch on `age_branches[]`. (Claude's call, builder-check Q4.) |
| E5 | **The clock** | The app keeps time: event onset timestamp (one tap "it started now / X minutes ago"), per-page timers (seizure duration, CPR cycles, time since adrenaline). Pages declare *what* to time; the engine times it and surfaces it in hand-off. |
| E6 | **Tone, voice, hands-free, big text** | Calm reassuring copy on every screen; everything read aloud (TTS) and operable by voice (STT) because the phone may be on the floor during compressions; thumb-sized targets; one idea per screen. |
| E7 | **Ambulance bar + local emergency number** | "📞 Call for an ambulance now" visible on every screen; tapping dials the **local** number. Numbers come from a **bundled per-country table with regional overrides** (compiled from public sources; works offline; e.g. Nigeria 112 national with state variants, EU 112, UK 999, US 911, India 112). Country is detected from device locale/time zone, refined by location only with consent, and always overridable by one tap ("Not in Nigeria? Change"). Unknown country → 112 (GSM fallback) plus "or your local emergency number". Table is versioned data with a source + review date per row. (Dami, 2026-11-10.) |
| E8 | **Responder toggle** | §4. Self-declared, persisted locally, progressive disclosure of the trained tier. |
| E9 | **Offline core** | PWA caches the engine and **every page**; the instant lane and all pages work with no network (§14). |
| E10 | **Universal holding page ("We're not sure yet")** | A signed, authored universal page shown whenever the engine has no confident match (E3 fallback), when the conversation lane is still waiting on the model, or offline with no button match. Content: call for an ambulance now; keep them still, warm, comfortable; watch breathing (loop to E2); don't give food or drink; what to tell the medic. Authored + signed in step 1 **before any condition page**. (Claude's call, builder-check Q3.) |
| E11 | **Known conditions ("Do they have any illness you know of?")** | One optional question, offered as a tap list (asthma · diabetes · heart / blood pressure · epilepsy · sickle cell · pregnancy · allergies · blood thinners · **I don't know**). "I don't know" is a first-class answer that changes nothing. Asked in the conversation lane after the first action is on screen, and shown on pages that declare `relevant_conditions[]` (§7). Never a gate; the answer can only **raise** urgency or open a page branch (asthma → find their inhaler; diabetes + confused → sugar if awake). Carried into the hand-off summary. (Dami, 2026-11-10 — users may not know, so it never blocks.) |
| E12 | **Nearest hospital — hand-off to the phone's own maps** | A "Find the nearest hospital" button beside every Get-help line opens the device's maps app pre-searched for hospital / emergency near the user (Apple Maps / Google Maps deep link). No maps SDK, no API key, no location stored or sent by us. Copy adds: "Pick one with an emergency unit (A&E)." Offline or no maps app → the line stays "get to the nearest hospital now". We never rank, verify or recommend a facility. (Dami, 2026-11-10 — revises the earlier "no facility finder".) |

---

## 7. The page template (the unit authored ~90×; stored as data, rendered by the engine)

Each condition record contains, in this order:

| # | Field | Content & rules |
|---|-------|-----------------|
| 0 | `id`, `title_plain`, `title_clinical` | Plain title the user sees ("Bleeding a lot"); clinical name for the health-worker tier and hand-off ("possible major haemorrhage"). |
| 0 | `system`, `presentations[]`, `age_branches[]`, `acuity` | Routing/ontology metadata (§5.1). v1 acuity = `immediate`. |
| 1 | **Recognition** | Plain-language picture of the situation + the confirming red flags the intake checks. Written as "this is likely what's happening if…", never "you have". |
| 1b | **`red_flag_questions[]`** | The **pre-authored, signed** yes/no questions the intake may ask for this page, each tagged with what a YES/NO changes (urgency or page). **The LLM never writes a question the user acts on — it only *selects* the next most decision-relevant question from this signed pool** (reason-and-redirect applied to questions). Keeps the ~3-question budget auditable and the forbidden-wording tests applicable. (Claude's call, builder-check Q2.) |
| 1c | **`relevant_conditions[]`** | Which known conditions (E11) matter for this page and what each unlocks (e.g. asthma → `health_worker` branch "their own inhaler, 4–10 puffs via spacer"). Empty on most pages. |
| 2 | **Urgency verdict** | Deterministic. v1: always `EMERGENCY_NOW`. (Field exists so v2 tiers reuse the template.) |
| 3 | **Get help** | Fixed line: "Call the emergency number or get to the nearest hospital now." Rendered with the local number (E7) and the maps hand-off button (E12). No in-app facility ranking. |
| 4 | **Do this now** | Step-by-step, **responder-tiered**: `anyone[]` then `health_worker[]` (with cited doses as verbatim facts). Each step may carry a **branch**: `if_no_better_after` → next steps (e.g. choking: back blows → thrusts → unconscious → CPR). This is the evolving-emergency decision tree. Steps may also carry an **equipment branch** `if_available` (AED, adrenaline auto-injector, tourniquet, inhaler/spacer, glucose, naloxone): shown only when the user taps "I have one", so a bystander without it is never told to use it. (From the D3 teardown, 2026-11-07; restored to the doc 2026-11-10.) |
| 5 | **Do NOT** | The dangerous don'ts (don't induce vomiting; don't move the neck; don't give food/drink). |
| 6 | **While you wait** | What to keep doing/watching; declares `timers[]` for the engine's clock. |
| 7 | **Hand-off** | What to tell the medic/doctor: onset time (from the clock), what happened, what was done, what was given. |
| 8 | **If it gets worse** | Safety-netting: worsening signs → re-act / re-call. |
| 9 | **Even if they seem fine** | When they must still be seen (biphasic anaphylaxis, head injury, near-drowning). |
| 10 | **Source** | The published guideline(s)/text each line is grounded in; page/section where possible. Rendered to the user as "Source: …" for trust. |
| — | `author_signoff` | Dami's sign-off marker + date; a page is not shippable without it. |

**Authoring rules:** facts (doses, danger signs, actions) are taken from published sources; wording is
ours; every line cites. Never reproduce a branded instrument's creative whole. Doses appear **only** in
the health-worker tier and are stored as verbatim facts with their citation (carrying forward v0's
build-time verification idea: a dose line must match its cited source).

---

## 8. Intake — the front desk (two lanes)

**Design constraint:** a terrified person cannot answer a questionnaire while someone is dying.

- **Instant lane.** Four big buttons on the home screen: *Not breathing / collapsed · Choking ·
  Bleeding a lot · Having a fit (seizure)*. One tap → E1/E2 gates (with the first action shown while
  answering) → the page. **Zero questions, zero AI, works offline.**
- **Conversation lane.** The user says or types what's happening in their own words (voice via STT).
  The LLM routes to candidate pages and asks **only the red-flag questions whose answers change the
  urgency or the page** — decision-relevant questioning, not history-taking. **Budget: provisional
  guidance after at most ~3 questions**, then keep refining as they answer (tune live). Streams; shows
  a provisional action immediately.
- **Both lanes** run E1 + E2 first and obey E3 (can't/won't answer → assume worst → safest page).
- **Offline:** the conversation lane needs the cloud LLM; with no network it degrades to guided buttons
  (a browsable, plain-language list of presentations) so nothing dead-ends.
- **Mental-health crisis** (suicidal person, acute agitation, overdose intent) is a first-class **presentation** in the conversation lane and in the offline presentation list — its red flags are behavioural, so it is routed like any other complaint, never hidden under a system name.
- **"It's me — I feel very unwell"** is a quiet secondary entry (patient-is-user) into the conversation
  lane with E4 pre-set to "me".

**The LLM's contract (reason-and-redirect):** input = normalized observations (typed/spoken text, and in
v1.1 the vision model's description); output = (a) ranked candidate page ids, (b) the next
decision-relevant question if one is needed, (c) a confidence signal. Output is grammar/schema-constrained
(as in v0). The engine, not the model, decides disposition; low confidence → E3.

---

## 9. Home screen and flow (structure + voice validated with Dami; visual look NOT designed yet)

Validated in low-fi mockups (`.superpowers/brainstorm/*/content/home-screen-v2.html`). Only
**structure, order, and copy** are settled; colours/typography/styling there are placeholders.

**On opening:**
1. Calm header: *"What's happening? I'm here to help."* Sub: *"Talk, type, or tap. You don't need the right words."*
2. Talk box with mic (the conversation lane).
3. Label *"Or tap if it's one of these"* → the four big instant-lane buttons (2×2), above the fold.
4. Quiet link: *"It's me — I feel very unwell."*
5. Persistent: *"📞 Call for an ambulance now."*

**Next beat, whatever they chose:** page header; in-voice line (*"Okay. You're doing the right thing by
getting help. One quick check first — look at them now."*); **E2** *"Are they awake and breathing
normally?"* Yes / No-or-not-sure; reassurance (*"Nothing bad happens if you're wrong."*); and the page's
**first action shown while they answer** (e.g. *"press hard on the bleeding with a cloth — don't stop to
look"*). Then the page proper (§7) in order.

---

## 10. Voice and language rules (apply to screens AND the AI conversation)

- Plain words on the surface: "bleeding a lot" not "haemorrhage"; "having a fit" not "seizure" (clinical
  term shown in brackets or in the health-worker tier).
- Calm, warm, steady. The app says **"we"** and reassures: *"You're doing great. Stay with me."*
  *"Nothing bad happens if you're wrong."* Never commands, never alarms, never blames.
- One idea per screen. Short sentences. Numbered steps. Big targets.
- Never "you have X". Always "this could be…", "possible…".
- The AI's conversational turns follow the same rules and are **short**: acknowledge → one question or
  one instruction. (Dami: "language to calm them down.")
- Everything is readable aloud and voice-operable.

---

## 11. Images (v1.1 — fast-follow, not a v1.0 blocker)

**Open upload is the universal baseline**: the user may attach a photo at any time; we do **not**
pre-enumerate per-situation image rules (it can't be made complete for "all emergencies").

**Mechanism — a common observation layer:** the vision model has one universal job: **describe the
image factually and neutrally** ("a brown snake, triangular head"; "a wound on the forearm ~6 cm,
actively bleeding"; "a medicine box labelled paracetamol 500 mg, blister mostly empty"). That description
is fed to the routing/page logic **exactly as if the user had typed it.** The per-condition page already
holds the clinical logic (e.g. snakebite: "can't tell → treat as venomous"). Coverage grows with the
library for free.

**Four universal rules:** (1) vision describes — never diagnoses, never sets urgency; (2) an image can
only **raise** concern, never lower it; (3) unclear/unreadable image → ignored for de-escalation, ask for
words; (4) never "this is X disease" from a photo.

**Prompted photos** are an optional per-page enhancement (burn: *"bigger than their palm? If unsure, take
a photo"*), not the baseline.

**Tech:** QVAC `QWEN3_5_4B_MULTIMODAL` (SDK-native text+image) and/or VisionPsy-Nano (460M VLM, GGUF)
+ `@qvac/ocr-ggml` for labels/documents — runs on the inference service.

---

## 12. Safety and regulatory posture (facts verified from primary text, 2026-11-08)

**Facts:**
- **US — FDA "Clinical Decision Support Software" guidance, final, issued 29 Jan 2026.** Non-device CDS
  must meet all four criteria of FD&C §520(o)(1)(E); criterion 3 is recommendations *"to a health care
  professional."* Verbatim: *"Software functions that support or provide recommendations to patients or
  caregivers – not HCPs – meet the definition of a device."* Software giving *"a specific, time-critical
  treatment output or directive"* is device behaviour. FDA *"does not intend at this time to enforce
  compliance"* for certain low-risk functions (per the Mobile Medical Applications and General Wellness
  policies) and *"supports increased access to … CDS for non-HCP users."*
- **EU — MDCG 2019-11 Rev.1 (June 2025), MDR Rule 11.** Software informing diagnostic/therapeutic
  decisions is class IIa; **class III** if a wrong decision *"may cause death or an irreversible
  deterioration"*; IIb for serious deterioration. Lay use is no exemption. Qualification is by intended
  medical purpose, not risk.

**Posture (settled):**
1. **We are a medical device by definition** in both jurisdictions. Design as regulated from day one;
   never claim "not a device."
2. **Risk class follows the consequence of a wrong answer.** v1 engineers the only possible error to be
   **over-triage**: every v1 output is "do this + call / nearest hospital"; there is no stay-home
   verdict; the death-if-wrong failure mode is structurally absent. This is the lowest-risk configuration
   and the strongest US enforcement-discretion case.
3. **Framing:** clinician-authored first-aid guidance that always escalates. "Possible/suspected" never
   "you have." Prominent "not a substitute for emergency services." No stored health data by default.
4. **EU/CE last.** Not a v1 blocker. Keep documentation discipline: the deterministic, cited,
   physician-signed pages *are* the clinical evidence file. Launch markets chosen deliberately.
5. **Images add no new exposure** (already a device via criterion 3) → v1.1 as designed.
6. **Legal counsel review before public launch** — a scheduled step.
7. **Reassess at v2** when the urgent tier reintroduces down-triage verdicts.

**Design rules that implement the posture:** E3 fail-safe; no `SELF_CARE`/`STAY_HOME` disposition exists
in v1 code paths; copy rules in §10; disclaimer on first open and in settings; terms of use; no
persistence of case text/audio/images beyond the session unless the user explicitly saves a hand-off
summary locally.

---

## 13. Content authoring and sourcing

- **Dami is the clinical author/sign-off at build time.** Claude drafts each page against published
  sources; Dami verifies against his training and signs off per system. (Public attribution of the
  author is a separate, parked decision.)
- **Sources:** standard emergency texts (Tintinalli's, Rosen's, Oxford Handbook of Emergency Medicine)
  as reference; open/public guidelines (AHA/ERC resuscitation, Surviving Sepsis, NICE, WHO materials,
  national first-aid bodies); primary literature where needed.
- **Idea–expression rule:** clinical **facts** (doses, danger signs, actions) are free to use and go
  into our table; **wording is ours**; every line cites its source. Never reproduce a branded
  instrument (ESI — ENA, all rights reserved; MTS — ALSG/Wiley paid licence; WHO IITT — CC BY-NC-SA,
  NonCommercial; CTAS — CAEP copyright) as the product.
- **Completeness is audited per shelf** against `EMERGENCY-SCOPE-v1.md`; a shelf is "done" when every
  listed condition has a signed page and its tests pass.
- **Tests per page (carry forward v0's discipline):** schema-valid; every dose line matches its cited
  source text; no forbidden wording ("you have", "stay home"); urgency = `EMERGENCY_NOW`; hand-off
  block present; at least one `anyone[]` step.

---

## 14. Architecture and deployment

**Two deployables, clean boundary:**

```
Phone (PWA, Next.js on Vercel)                      Inference service (Node + @qvac/sdk 0.23.x, Oracle Cloud)
 ├─ engine (E1–E12), page renderer                    ├─ MedPsy-4B (routing/classification; GBNF/schema output)
 ├─ ALL pages cached offline (static data)           ├─ tool-calling / multi-turn for the conversation lane
 ├─ instant lane: zero network                       ├─ ASR (speech-to-text), TTS (voice out), NMT (later)
 ├─ conversation lane ──HTTPS/SSE──▶                 ├─ v1.1: multimodal/VLM + OCR (describe-only)
 └─ STT/TTS: on-device where available, else service └─ no persistence of case data; rate-limit; CORS to Vercel origin
```

- **Client:** Next.js PWA, installable, service-worker caches engine + all pages; works offline for the
  instant lane and every page. Voice I/O uses platform APIs when available, falls back to the service.
- **Inference service:** Node + `@qvac/sdk` **0.23.x** (migrated from 0.13.3 — step 0; expect breaking
  changes; the old `sdk.ts` shim is replaced). Runs MedPsy-4B by default. Hosted on **Oracle Cloud**,
  starting on the Always-Free **Ampere A1 (4 OCPU / 24 GB, ARM)**. **Confirm at build** that the QVAC
  SDK/native addons run on ARM Linux; **fallback:** MedPsy is a standard GGUF → serve it via plain
  `llama.cpp` (and an OpenAI-compatible shim) on any shape, keeping the same client contract.
- **Latency constraint (named risk):** v0 measured MedPsy-4B at ~26 s to first token on an 8 GB M1 CPU.
  Mitigations are *architectural*, not hopeful: the LLM is never on the path to the first instruction
  (instant lane + pages); the conversation lane streams and shows provisional guidance immediately;
  hard token caps (the job is tiny: classify + one question); if 4B is still too slow on the Oracle box,
  route with MedPsy-1.7B or move to a GPU shape. Target: first provisional guidance < 3 s perceived.
- **Carried forward from v0:** the deterministic table pattern, the severity gate's danger-sign /
  negation logic, grammar-constrained extraction, the inference lock + queue bound, sanitized errors,
  the egress-guard idea (now applied to the service: no third-party calls during inference), and the **prompt-injection fencing** (user text is quoted data inside a fixed instruction frame; the model can only choose page ids and pre-authored questions, so injected text cannot change an action).
- **Security/privacy:** HTTPS only; restrictive CORS; request-size limits; rate limiting; no logging of
  case content; health checks expose no data.
- **Frontend hosting:** Vercel; Dami will buy a custom domain and point it at Vercel.

---

## 15. Build sequence and milestones

0. **Foundations spike (days).** Migrate to `@qvac/sdk` 0.23.x; stand up the inference service on
   Oracle Ampere; prove MedPsy-4B routing + tool-calling + schema output end-to-end; measure latency;
   decide 4B vs 1.7B vs GPU; prove the llama.cpp fallback if the SDK won't run on ARM.
   *Exit:* a `POST /route` that returns ranked page ids + next question for a typed case, within budget.
1. **The engine, empty of medicine.** PWA shell; home screen (§9); E1–E12 (incl. the emergency-number table); page renderer from the
   template-as-data; responder toggle; clock; ambulance bar; offline caching; conversation lane wired to
   the service with streaming and E3 fallbacks; test harness for pages (§13).
   *Exit:* a fake page renders and runs through both lanes, online and offline, on a phone.
2. **Internal milestone — six universal life-savers.** Author + sign off collapse/CPR, choking, severe
   bleeding, anaphylaxis, seizure, stroke; wire; test on a phone with real people reading the copy.
   *Exit:* Dami runs all six on his phone and accepts the voice and flow.
3. **Content sweep to the ship line.** System by system per `EMERGENCY-SCOPE-v1.md`; Dami signs off per
   shelf; per-page tests green. *Exit:* every v1 condition has a signed, tested page → **ship v1.**
4. **v1.1 — images** (§11).
*In parallel from step 1:* the **high-fi visual design pass** (2–3 distinct directions, Dami picks;
palette is his taste call); **legal counsel review**; Oracle + Vercel + domain; README/landing refresh.

---

## 16. Constraints and risks

| Risk / constraint | Handling |
|---|---|
| LLM latency on CPU (4B ≈ 26 s TTFT on M1 in v0) | Architectural: LLM never gates first instruction; stream + provisional; token caps; 1.7B or GPU fallback. Measured at step 0. |
| QVAC SDK on Oracle ARM unconfirmed | Spike at step 0; llama.cpp + GGUF fallback keeps the client contract. |
| SDK 0.13.3 → 0.23.0 breaking changes | Step 0; replace the old shim; keep tests. |
| Under-triage anywhere | Forbidden by design: no stay-home disposition in v1 code; E3; per-page tests for forbidden wording. |
| Scope creep into diagnosis | §3.1 + §10 + tests for "you have". |
| Content licensing | §13 idea–expression rule; no branded instruments. |
| Regulatory | §12 posture; counsel before launch; reassess at v2. |
| Authoring load (~90 pages) | Fixed template, per-shelf sign-off, tests; six-page milestone first. |
| Offline + voice in a crisis | E6/E9; test on a real phone, airplane mode, one-handed. |

---

## 17. Decision provenance

**Decided by Dami:** the vision (laypeople + health workers guided until the doctor arrives); emergency
tier first, then all of medicine; offline is no longer the moat — pick the best tech; "triage, not
diagnosis"; he is the clinical author/sign-off (app autonomous at runtime); "get to the nearest
hospital" via the phone's own maps + the local emergency number, no in-app facility ranking (revised
2026-11-10); the known-conditions question (E11); public repo; launch posture (§20); two-lane intake; open image upload (not per-case rules); responder
toggle unverified + app stops at hand-off; the regulatory posture (§12); PWA + cloud inference +
offline core; Oracle Cloud (not Render), custom domain → Vercel; keep the name **Triage-0**; same repo
+ Next.js PWA on Vercel + Node/QVAC on Oracle; the build sequence.

**Claude's calls (overridable, stated in the deliberation):** presentation-first spine with age as a
branch; the "one engine, growing library" framing; slicing the ship line by acuity; the engine/page
split (§3.4) and which gaps became engine behaviours; the page template fields and order; question
budget (~3); prompted photos as enhancement; the four image rules; the merged home-screen structure;
images as v1.1; Ampere A1 as the first shape; the per-page test list; the MedPsy-4B default with 1.7B
fallback; "first action before first question."

---

## 18. Left to the builder

- Exact Next.js structure, state management, service-worker strategy, and the page-data format
  (JSON/YAML/TS) — provided the template fields in §7 are preserved and validated by schema.
- Exact `@qvac/sdk` 0.23 API usage for completion, tool-calling, ASR/TTS, and (v1.1) multimodal; the
  `/route` and streaming contracts between client and service.
- The conversation-lane question planner (how candidate pages map to the next decision-relevant question),
  provided it obeys the ~3-question budget, E3, and the LLM contract in §8.
- Timer UX details; how the hand-off summary is presented (and optionally saved locally).
- Emergency-number table: source of truth, format, and the review process for rows (behaviour fixed in E7).
- Accessibility specifics (contrast, dynamic type, screen-reader labels, haptics) — required, details open.
- The visual design system (separate pass; Dami picks the direction).
- Infra specifics: Oracle networking/HTTPS/reverse proxy, CI, monitoring (no case data in logs).

---

## 19. Parked / later decisions
- Public attribution of Dami as clinical author (vs internal-only sign-off).
- Business model specifics (shape settled: free to users; revenue via partner/org licensing, grants).
- Native iOS/Android apps.
- In-app facility ranking/verification and transport (out; maps hand-off only, E12).
- Written confirmation from Tether on MedPsy commercial/hosted use (Dami 2026-11-10: not a build gate; ask before a commercial launch).
- v2: urgent tier + the down-triage question + formal device classification / CE.
- Multilingual (v0 had fr/es via Bergamot; re-add after v1 on the 0.23 NMT addon).

---

## 20. Builder-check resolutions (2026-11-09)

A fresh reviewer read this document as the builder and raised nine questions. Resolution:

**Open for Dami (answer changes what gets built):**
- **Q1 — E2 gate logic.** Reviewer caught that a single "awake *and* breathing normally?" question would send a conscious asthmatic/anaphylaxis patient to CPR. Rewritten above as a two-step DRS-ABC gate (responding? → breathing?). **Dami 2026-11-10: accepted; added the known-conditions question → E11.**
- **Q5 — Launch market and language.** Sets the default emergency number, content emphasis (e.g. severe malaria, naloxone/adrenaline availability), counsel jurisdiction, test devices, and whether English-only is acceptable at ship. **Dami 2026-11-10: asked for it in plain words; wants emergency numbers for every country/region (→ E7) and maps for the nearest hospital (→ E12).** With a global number table the question shrinks. **Claude's call, overridable: build for anywhere, English only in v1 (plain words carry the load; local languages v1.x); first real-world testing, device matrix (low-end Android + iPhone) and legal counsel in Nigeria, Dami's base.**
- **Q6a — Repo visibility now.** Public (Apache-2.0, as v0) vs private during the build. Affects what may be committed and how our authored content is licensed. **Dami 2026-11-10: public.** Consequence: code stays Apache-2.0; authored pages get an explicit content licence (CC BY-SA 4.0 proposed, decided in step 0); nothing confidential (sources dir, keys) is ever committed (Q6b).

**Settled as Claude's calls (a sensible builder would land here; overridable):**
- **Q2 — Red-flag questions are pre-authored per page** (`red_flag_questions[]`, §7); the LLM only selects among them. Only answer consistent with §3.3.
- **Q3 — A universal "We're not sure yet" holding page exists** (E10, §6), authored and signed in step 1.
- **Q4 — Age band is asked once, folded into E4**, one tap, skippable, defaults to adult.
- **Q6b — Dose-verification tests never commit copyrighted excerpts.** Verify dose lines against **open-licensed source text** (WHO/AHA/ERC/NICE where licences allow) committed as fixtures, or against a **private, git-ignored sources directory** with hashed assertions for textbook-derived facts. Textbooks remain reference-only.
- **Q7 — v0 is preserved, not deleted.** Tag `v0.2.0-hackathon` + branch `v0-hackathon`; v1 is built at the repo root; CHW-specific v0 pieces (WHO RAG ingest, Bergamot translation, Orynth files) move to `archive/v0/` in step 0 and stay recoverable. Nothing is lost; v0 is not kept *runnable* at root.
- **Q8 — Speech goes through our own service by default** (QVAC ASR/TTS on Oracle). Platform speech APIs are used only where they run **on-device** (feature-detected) or with explicit user consent; audio is never silently sent to Google/Apple. Consistent with §12/§14 posture.

**Verified as fact (see Appendix):**
- **Q9 — Model and SDK licences for hosted commercial use (verified 2026-11-09 from primary pages).**
  - **`@qvac/sdk`: standard Apache-2.0.** GitHub LICENSE = Apache License 2.0, © 2026 Tether Data, S.A. de C.V.; docs: "100% free to use and modify, released under Apache 2.0 license"; npm registry per-version `license: Apache-2.0`. Commercial and hosted/server use permitted; obligations = keep licence text + notices on redistribution. Dependent `@qvac/*` native packages assumed same but not individually checked — confirm in step 0.
  - **MedPsy-1.7B / MedPsy-4B (all three HF cards): metadata `License: apache-2.0`, BUT the Licensing paragraph reads "licensed by Tether Data … under the Apache 2.0 license *for research and educational purposes*."** That qualifier is undefined on the cards; Apache-2.0 itself permits commercial use, but the wording is ambiguous and the Genesis training datasets are CC-BY-NC 4.0 (non-commercial; effect on weights unstated). **Action before public/commercial launch: obtain a written answer from Tether** on commercial + hosted use of MedPsy weights. **Mitigation / why this is not a design blocker:** the model only *routes* (reason-and-redirect); the moat is the pages + architecture, so the weights are swappable — fallback is any permissively-licensed model (e.g. base Qwen3-4B, Apache-2.0) with our deterministic pages, at some cost in routing quality. **Dami 2026-11-10: "don't worry about the licence, we can build" — not a build gate; parked in §19 as a pre-commercial-launch action.**
  - Model cards' advisory language ("always include visible disclaimers"; "not a substitute for professional medical judgment"; "no direct clinical diagnosis or treatment without oversight by qualified healthcare professionals") is consistent with §12 and must be honoured in-product.

## Appendix — references
- Deliberation trail & register: `docs/context/2026-11-06-PRODUCTION-TRANSFORM-HANDOFF.md`
- v1 scope enumeration: `docs/context/EMERGENCY-SCOPE-v1.md`
- Home-screen wireframes: `.superpowers/brainstorm/*/content/home-screen*.html` (structure/voice only)
- Prior app: `README.md`, `src/triage/*`, `DEEP-CRITIQUE-REPORT.md`, `docs/plans/2026-08-21-hybrid-*`
- Verified sources: FDA CDS guidance (29 Jan 2026); MDCG 2019-11 Rev.1 (Jun 2025); Semigran BMJ
  2015;351:h3480; Schmieding J Med Internet Res 2022;24(5):e31810; Fraser JMIR mHealth 2023;11:e49995;
  QVAC release sdk-v0.23.0 (2 Nov 2026), MedPsy model cards / arXiv 2611.02011.
