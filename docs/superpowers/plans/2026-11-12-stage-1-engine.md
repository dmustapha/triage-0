# Stage 1 — The Engine, Empty of Medicine: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-installable web app that runs every universal engine behaviour (E1–E12), renders any page authored in the §7 template from data, works offline for the instant lane and every cached page, and talks to the Stage 0 service for the conversation lane with fail-safe fallbacks, proven on a real phone with one fake page and the signed holding page.

**Architecture:** Three workspaces. `content/` holds the page schema (§7 as zod), the authored pages as JSON, the emergency-number table, and the per-page test harness; it is the single source of truth and generates the service's catalogue. `web/` is a Next.js 16 PWA (App Router, static export, Serwist service worker) whose engine modules (gates, clock, emergency number, responder, conversation lane, speech) are pure TypeScript with unit tests, rendered by thin React components. `service/` (Stage 0) gains two speech endpoints and consumes the generated catalogue; the `/route` contract is unchanged.

**Tech Stack:** Next.js 16.4 (App Router, `output: "export"`), React 19.3, TypeScript 5.7, zod 4, @serwist/next 9.5 (service worker precache), vitest 5 (unit), @playwright/test 1.65 (mobile emulation + offline + axe), the Stage 0 service (Node 24, express, @qvac/sdk 0.23, llama-server). No CSS framework: CSS modules with a tokens file; the visual design pass is separate (§15).

**Spec:** `docs/superpowers/specs/2026-11-09-triage-0-v1-production-design.md` (§4, §6–§10, §12–§14, §18, §20). Scope line: `docs/ROADMAP.md` → Stage 1. Prior stage: `docs/STAGE-0-RESULTS.md`, `docs/superpowers/plans/2026-11-10-stage-0-foundations.md`.

## Global Constraints

- Only possible error is over-triage: "no `SELF_CARE`/`STAY_HOME` disposition exists in v1 code paths" (§12). v1 urgency is always `EMERGENCY_NOW` (§7 row 2).
- E3: "Under any doubt (no answer, timeout, low model confidence, ambiguous input) round up to the more urgent disposition. Never down."
- E2 is two steps, DRS-ABC: "Are they awake / responding to you?" → if NO: "Are they breathing?"; not breathing / not sure → `collapse_cpr`; "Not sure always takes the more urgent branch"; a conscious person with breathing difficulty is never routed to CPR; the page's first action is shown while answering.
- Copy rules (§10): plain words on the surface; the app says "we"; never "you have X", always "this could be…/possible…"; one idea per screen; short sentences; thumb-sized targets (≥ 48 px); everything readable aloud.
- Red-flag questions are pre-authored and signed per page; "The LLM never writes a question the user acts on" (§7 1b). Stage 0 ruling carried: the model emits page ids + confidence only; the catalogue picks the next question.
- Conversation lane: provisional guidance after at most ~3 questions; show the holding page while waiting (E10, A3.4).
- Speech (§20 Q8): through our own service by default; platform speech APIs only where on-device (feature-detected) or with explicit consent; "audio is never silently sent to Google/Apple".
- Privacy (§12, A6.3): no case text, audio or images kept beyond the session unless the user explicitly saves a hand-off summary; no logging of case content on the service.
- Disclaimer on first open and in settings; terms of use; "not a substitute for emergency services" (A6.2). Model-card advisory honoured: visible disclaimer; no diagnosis claims.
- E7: bundled per-country table with regional variants, auto-detected from device region, one-tap override, 112 fallback, each row sourced and dated; works offline.
- E9: installable PWA; engine and every page cached; instant lane and all pages work with no network.
- E12: opens the phone's own maps app searched for hospital/emergency; no maps SDK, no API key, no location stored or sent.
- Service hardening from Stage 0 stays: loopback bind, exact CORS allowlist, 16 kB JSON limit, 30/min rate limit, redacting logger (allow-listed keys, 64-char cap, error names only).
- Repo is public, Apache-2.0 code, authored pages CC BY-SA 4.0; nothing confidential committed; sources for dose checks are open-licensed fixtures or a git-ignored private directory with hashed assertions (§20 Q6b).
- Page template fields (§7) preserved exactly in the schema: `id, title_plain, title_clinical, system, presentations[], age_branches[], acuity, recognition, red_flag_questions[], relevant_conditions[], urgency, get_help, do_now{anyone[], health_worker[]}, do_not[], while_you_wait{text, timers[]}, hand_off, if_worse, even_if_fine, source[], author_signoff`.

## Review Focus

1. Phone offline, user taps "Bleeding a lot": the gate screens, the first action and the full page must all render from cache with no network request; a reasonable person expects no spinner and no error. Pinned in Task 12 (Playwright `context.setOffline(true)` test).
2. Conversation lane with the service unreachable, slow (> 20 s), or returning `fallback: true`: the user must see the holding page within one second of submitting and never a blank screen or raw error text. Pinned in Task 9.
3. E2 answered "No" to responding then "not sure" about breathing, on a page that is not CPR (e.g. the fake bleeding page): the engine must route to `collapse_cpr`, never stay on the tapped page. Pinned in Task 4.
4. A page JSON that is missing `author_signoff`, contains "you have", or has no `anyone[]` step must fail the harness and must not be bundled into the app build. Pinned in Task 2 and Task 11.
5. Device region unknown (no time zone, unusual locale): the ambulance bar must still dial a number (112) and the override must persist; a wrong country must be fixable in one tap. Pinned in Task 6.

---

## File structure

```
content/                                   (new workspace, name "@triage-0/content")
  package.json  tsconfig.json
  schema/page.ts            zod PageSchema (§7) + types; PRESENTATION list schema; EmergencyNumberRow schema
  schema/forbidden.ts       FORBIDDEN_PHRASES, DISPOSITIONS (only EMERGENCY_NOW)
  pages/holding.json        E10 universal page (Dami signs)
  pages/_fixtures/fake_bleeding.json   test-only page (never bundled; drives the exit test)
  presentations.json        offline browsable list (A1.6): six life-savers + mental-health crisis + holding
  emergency-numbers.json    E7 table: rows with country, regions[], source, checked
  tz-country.json           IANA time zone → ISO country (bundled, small)
  sources/                  open-licensed source excerpts for dose checks (fixtures)
  scripts/check-pages.ts    harness (A5.3): schema, forbidden words, urgency, hand-off, anyone[], dose↔source, signoff
  scripts/build-catalog.ts  pages → service/catalog/stage1.json (id, title_plain, cues, red_flag_questions)
  scripts/build-web-data.ts pages + numbers + presentations → web/src/data/*.json (signed pages only)
  tests/*.test.ts           harness unit tests (vitest)

web/                                       (new workspace, "@triage-0/web")
  package.json  next.config.ts  tsconfig.json  playwright.config.ts  vitest.config.ts
  public/manifest.webmanifest  public/icons/*
  src/app/layout.tsx  globals.css  tokens.css
  src/app/page.tsx                home (§9)
  src/app/go/[pageId]/page.tsx    gates → page (both lanes land here)
  src/app/talk/page.tsx           conversation lane
  src/app/list/page.tsx           offline presentation list
  src/app/settings/page.tsx       responder toggle, country override, disclaimer, terms
  src/app/sw.ts                   Serwist service worker (precache everything)
  src/data/*.json                 generated (gitignored except holding + numbers? no: committed by build-web-data, see Task 3)
  src/engine/gates.ts             E1/E2 state machine (pure)
  src/engine/routeDecision.ts     E3 ranking: candidates → page id, fallback → holding
  src/engine/clock.ts             E5 onset + timers (pure, injectable now())
  src/engine/emergencyNumber.ts   E7 detect + override
  src/engine/responder.ts         E8 persisted toggle
  src/engine/conditions.ts        E11 known-conditions → branches
  src/engine/maps.ts              E12 deep links
  src/engine/conversation.ts      lane client: /route calls, 3-question budget, holding while waiting
  src/engine/speech.ts            STT/TTS: on-device platform APIs when provably local, else service with consent
  src/engine/session.ts           in-memory case state, hand-off summary, explicit copy only
  src/components/*.tsx            AmbulanceBar, GateCard, PageSections, QuestionCard, BigButtons, Disclaimer, CountryPicker…
  src/lib/api.ts                  typed fetch of RouteRequest/RouteResponse (types copied from service/src/contract.ts via build-web-data)
  tests/unit/*.test.ts            vitest (engine modules)
  tests/e2e/*.spec.ts             Playwright: home, instant lane offline, conversation fallback, axe

service/  (modify)
  src/speech/asr.ts  src/speech/tts.ts  src/speech/routes.ts   POST /speech/transcribe, POST /speech/say
  src/index.ts  (mount speech routes; catalogue path env CATALOG_PATH default catalog/stage1.json)
  scripts/spike-speech.ts
  tests/integration/speech.test.ts
package.json (root)  workspaces: ["service","content","web"]; scripts: test, typecheck, build
```

**Interfaces shared across tasks (the implementer of each task sees only their own; these are the contract):**

- `content/schema/page.ts` exports `PageSchema`, `type Page`, `QuestionSchema`, `type Question = { id: string; text: string; yes_changes: "urgency"|"page"|"none"; no_changes: "urgency"|"page"|"none"; yes_page?: string }`, `StepSchema`, `type Step = { text: string; if_no_better_after?: { seconds: number; then: Step[] }; if_available?: { equipment: string; then: Step[] }; dose?: { text: string; source_ref: string } }`, `TimerSchema = { id, label, kind: "stopwatch"|"interval", every_seconds? }`, `EmergencyNumberRowSchema`, `PresentationSchema = { id, title_plain, page_id, keywords: string[] }`.
- `web/src/engine/gates.ts`: `type GateState = { step: "scene"|"responding"|"breathing"|"done"; outcome?: "page"|"cpr" }`, `gateReducer(state, event: "safe"|"unsafe"|"yes"|"no"|"unsure") → GateState`.
- `web/src/engine/routeDecision.ts`: `decide(res: RouteResponse | null, err: "timeout"|"network"|"server"|null): { pageId: string; provisional: boolean }` (holding id `"holding"`).
- `web/src/engine/conversation.ts`: `createLane(api, opts: { timeoutMs: 20000; maxQuestions: 3 })` with `submit(text, ctx) → Promise<LaneState>`, `answer(questionId, "yes"|"no"|"unsure") → Promise<LaneState>`, `type LaneState = { pageId: string; provisional: boolean; question: { id; text } | null; asked: number; waiting: boolean }`.
- `web/src/engine/emergencyNumber.ts`: `detectCountry(env: { timeZone?: string; locale?: string }) → string | null`, `numberFor(country: string | null, table, region?: string) → { dial: string; label: string; country: string }` (112 fallback), `getOverride()/setOverride(country, region?)`.
- `service` speech: `POST /speech/transcribe` body `audio/webm` or `audio/wav` ≤ 1 MB → `{ text: string }`; `POST /speech/say` JSON `{ text: string (≤ 400 chars) }` → `audio/wav`.

---

### Task 1: Workspaces, page schema, forbidden-wording constants

**Files:**
- Create: `content/package.json`, `content/tsconfig.json`, `content/schema/page.ts`, `content/schema/forbidden.ts`, `content/vitest.config.ts`
- Modify: `package.json` (root: workspaces + scripts), `.gitignore` (`content/sources-private/`)
- Test: `content/tests/schema.test.ts`

**Interfaces:**
- Produces: the shared schema exports listed above; `FORBIDDEN_PHRASES: RegExp[]` = `/\byou have\b/i`, `/\bstay (at )?home\b/i`, `/\bself[- ]care\b/i`, `/\bno need to\b/i`; `DISPOSITIONS = ["EMERGENCY_NOW"] as const`.

- [ ] **Step 1: Failing schema tests**

```ts
test("a minimal valid page passes", () => assert.equal(PageSchema.safeParse(minimalPage).success, true));
test("urgency other than EMERGENCY_NOW is rejected", () => assert.equal(PageSchema.safeParse({ ...minimalPage, urgency: "URGENT" }).success, false));
test("red_flag_questions ids must be <page>_q<n>", () => assert.equal(PageSchema.safeParse({ ...minimalPage, red_flag_questions: [{ id: "x", text: "?", yes_changes: "none", no_changes: "none" }] }).success, false));
test("a health_worker dose step must carry source_ref", () => assert.equal(PageSchema.safeParse({ ...minimalPage, do_now: { anyone: [{ text: "a" }], health_worker: [{ text: "b", dose: { text: "10 mg" } }] } }).success, false));
test("author_signoff is { by, date } or null", () => { assert.equal(PageSchema.safeParse({ ...minimalPage, author_signoff: null }).success, true); assert.equal(PageSchema.safeParse({ ...minimalPage, author_signoff: "x" }).success, false); });
```
`minimalPage` = every §7 field with one entry each, `id: "fake_bleeding"`.

- [ ] **Step 2: Run** `npm test --workspace content` → FAIL (module not found).
- [ ] **Step 3: Implement `content/schema/page.ts`** with the §7 fields in order; `acuity: z.literal("immediate")`; `urgency: z.literal("EMERGENCY_NOW")`; `age_branches: z.array(z.enum(["baby","child","adult","pregnant","older_adult"]))`; `source: z.array(z.object({ title, url: z.string().url().optional(), section: z.string().optional() })).min(1)`; `author_signoff: z.object({ by: z.string(), date: z.string().date() }).nullable()`.
- [ ] **Step 4: Run** → PASS. Root `npm test` runs all three workspaces.
- [ ] **Step 5: Commit** `feat(content): page schema (§7) and forbidden-wording constants`

---

### Task 2: The page harness (A5.3) and the two Stage 1 pages

**Files:**
- Create: `content/scripts/check-pages.ts`, `content/pages/holding.json`, `content/pages/_fixtures/fake_bleeding.json`, `content/sources/erc-2021-bls-excerpt.md` (open-licensed excerpt or hash-only stub, see Q6b), `content/tests/check-pages.test.ts`
- Modify: `content/package.json` (script `check`)

**Interfaces:**
- Produces: `checkPage(page: unknown, opts: { sourcesDir: string; requireSignoff: boolean }) → { ok: boolean; errors: string[] }` and CLI `npm run check --workspace content` (exit 1 on any error; `_fixtures/` checked with `requireSignoff: false`).
- Produces: `pages/holding.json` with `id: "holding"`, `author_signoff: null` until Dami signs (the build in Task 3 refuses to bundle an unsigned non-fixture page, so Stage 1's exit needs his signature).

- [ ] **Step 1: Failing harness tests**

```ts
test("fixture page passes with requireSignoff=false", () => assert.deepEqual(checkPage(fake, { sourcesDir, requireSignoff: false }).errors, []));
test("'you have' anywhere fails with the phrase named", () => assert.match(checkPage({ ...fake, recognition: "you have a cut" }, o).errors.join(), /you have/));
test("no anyone[] step fails", ...);
test("missing hand_off fails", ...);
test("dose text not found in its source_ref fixture fails", () => { /* dose "500 mg" vs excerpt containing "300 mg" */ });
test("unsigned page fails when requireSignoff=true", ...);
test("holding.json parses and is EMERGENCY_NOW with no questions", () => assert.equal(holding.red_flag_questions.length, 0));
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `holding.json`** (E10 content, drafted for Dami's signature): `title_plain: "We're not sure yet"`; recognition: "We can't tell yet what's happening, and that's okay. We'll keep you doing the right things while help comes."; `do_now.anyone` = call for an ambulance now; keep them still, warm and comfortable; stay with them; watch their breathing (if it stops or changes, go to Not breathing / collapsed); don't give food or drink; `hand_off` = when it started, what you saw, what you did; `source` = ERC 2021 BLS / first-aid guideline citation; `author_signoff: null`. Write `_fixtures/fake_bleeding.json`: a complete but obviously fake page (`title_plain: "FAKE PAGE — bleeding a lot (test only)"`, two red-flag questions `fake_bleeding_q1` "Is the blood spurting or soaking through?" yes→urgency, `fake_bleeding_q2`, one `anyone[]` step with `if_no_better_after: { seconds: 600, then: [...] }`, one `health_worker[]` dose step with `source_ref: "erc-2021-bls-excerpt#tourniquet"`, `timers: [{ id: "pressure", label: "Keep pressing", kind: "interval", every_seconds: 120 }]`, `age_branches: ["child"]`, `relevant_conditions: ["blood_thinners"]`).
- [ ] **Step 4: Implement `check-pages.ts`**: zod parse → forbidden phrases over every string field (walk the object) → `urgency === "EMERGENCY_NOW"` → `hand_off` non-empty → `do_now.anyone.length ≥ 1` → for each dose: read `sourcesDir/<file>.md`, find `#<anchor>` section, assert `dose.text` substring present (or, if a `.sha256` sidecar exists instead of the excerpt, assert `sha256(dose.text)` listed) → signoff rule. CLI walks `pages/**/*.json`.
- [ ] **Step 5: Run** `npm test --workspace content && npm run check --workspace content` → PASS; `check` prints `holding.json: UNSIGNED (allowed until build)`.
- [ ] **Step 6: Commit** `feat(content): page harness, holding page draft, fake fixture page`

---

### Task 3: Build steps: catalogue for the service, data for the web app

**Files:**
- Create: `content/scripts/build-catalog.ts`, `content/scripts/build-web-data.ts`, `content/presentations.json`, `content/tests/build.test.ts`
- Modify: `service/src/catalog.ts` (`CATALOG_PATH` from env, default `catalog/stage1.json`; keep `STAGE0_PATH` for tests), `service/catalog/stage1.json` (generated, committed), root `package.json` (`build:content`)

**Interfaces:**
- Consumes: `PageSchema`, `checkPage`.
- Produces: `service/catalog/stage1.json` in the Stage 0 `Catalog` shape (`pages[{id,title_plain,cues,red_flag_questions[{id,text}]}]`, `holding_page_id: "holding"`), `cues` = `presentations[].keywords` for pages that have a presentation plus `recognition` split into ≤ 8 short phrases; `web/src/data/pages.json` (signed pages only + fixtures only when `INCLUDE_FIXTURES=1`), `web/src/data/presentations.json`, `web/src/data/emergency-numbers.json`, `web/src/data/contract.ts` (copied from `service/src/contract.ts`).

- [ ] **Step 1: Failing tests**: catalogue has `holding` + every page id; fixture excluded unless `INCLUDE_FIXTURES=1`; unsigned non-fixture page aborts `build-web-data` with exit 1 and the page id; `stage1.json` loads with the Stage 0 `loadCatalog` (import from `../../service/src/catalog.js`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; also `npm test --workspace service` still green with `CATALOG_PATH` unset (Stage 0 tests pin `STAGE0_PATH`).
- [ ] **Step 5: Commit** `feat(content): build catalogue and web data from pages`

---

### Task 4: Web workspace, tokens, the E1/E2 gate engine

**Files:**
- Create: `web/package.json`, `web/next.config.ts` (`output: "export"`, `images.unoptimized`), `web/tsconfig.json`, `web/vitest.config.ts`, `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/src/app/tokens.css`, `web/src/engine/gates.ts`, `web/src/components/GateCard.tsx`
- Test: `web/tests/unit/gates.test.ts`

**Interfaces:**
- Produces: `gateReducer` (above); `GateCard({ state, firstAction, onEvent })` renders the §9 copy verbatim: "Okay. You're doing the right thing by getting help. One quick check first — look at them now." → scene step "Is it safe for you to help? (fire, traffic, electricity, water, violence, gas)" [Yes / No] → "Are they awake and responding to you?" [Yes / No, or not sure] → "Are they breathing?" [Yes / No, or not sure]; reassurance line "Not sure? Tap 'No' — we'll check together. Nothing bad happens if you're wrong."; "While you answer:" + `firstAction`.

- [ ] **Step 1: Failing reducer tests**

```ts
test("scene unsafe → stays on scene with warning, never advances", ...);
test("responding yes → done/page", () => assert.deepEqual(run(["safe","yes"]), { step: "done", outcome: "page" }));
test("responding no + breathing no → done/cpr", () => assert.deepEqual(run(["safe","no","no"]), { step: "done", outcome: "cpr" }));
test("responding no + breathing unsure → cpr (doubt rounds up)", () => assert.equal(run(["safe","no","unsure"]).outcome, "cpr"));
test("responding unsure → treated as no", () => assert.equal(run(["safe","unsure","yes"]).step, "done"));
test("responding no + breathing yes → page (recovery handled by page)", () => assert.equal(run(["safe","no","yes"]).outcome, "page"));
```

- [ ] **Step 2: Run** `npm test --workspace web` → FAIL. **Step 3: Implement** reducer + card (buttons ≥ 48 px via tokens `--tap: 48px`; base font 18 px). **Step 4: Run** → PASS; `npm run typecheck --workspace web` clean. **Step 5: Commit** `feat(web): workspace, tokens, E1/E2 gate engine`

---

### Task 5: Page renderer from template data (E8 tiers, E5 timers, E11 branches, E12 button)

**Files:**
- Create: `web/src/components/PageSections.tsx`, `web/src/engine/clock.ts`, `web/src/engine/responder.ts`, `web/src/engine/conditions.ts`, `web/src/engine/maps.ts`, `web/src/app/go/[pageId]/page.tsx`
- Test: `web/tests/unit/clock.test.ts`, `responder.test.ts`, `conditions.test.ts`, `maps.test.ts`, `page-render.test.tsx` (react testing via vitest + jsdom)

**Interfaces:**
- Produces: `createClock(now: () => number)` with `setOnset(msAgo)`, `start(timer)`, `elapsed(id)`, `summary() → string[]` (for hand-off); `getResponder()/setResponder(bool)` (localStorage key `t0.responder`); `branchesFor(page, conditions: string[]) → Step[]`; `mapsUrl(ua: string) → string` = iOS `maps://?q=hospital%20emergency`, Android `geo:0,0?q=hospital%20emergency`, else `https://www.google.com/maps/search/hospital+emergency`.
- Page route: `/go/[pageId]` runs `GateCard` first (E2), with `firstAction = page.do_now.anyone[0].text`; outcome `cpr` navigates to `/go/collapse_cpr` (Stage 1: id exists in presentations; page missing → holding with a note), outcome `page` renders sections in §7 order: Get help (ambulance number + maps button) → Do this now (anyone; health_worker tier only when responder on, doses shown verbatim with "Source:") → Do NOT → While you wait (timers) → Hand-off (onset + clock summary + what was done) → If it gets worse → Even if they seem fine → Source.

- [ ] **Step 1: Failing tests**: clock elapsed/onset/summary; responder persistence; `branchesFor` returns the `health_worker` branch only when responder on and condition matches; `mapsUrl` per UA; render test: health_worker steps absent by default, present after `setResponder(true)`; no string "you have" in rendered DOM; every `anyone[]` step is a numbered `<li>`; the `if_no_better_after` branch is collapsed under "If it's not better after 10 minutes".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): page renderer, clock, responder tier, conditions, maps hand-off`

---

### Task 6: Ambulance bar and the emergency-number table (E7)

**Files:**
- Create: `content/emergency-numbers.json`, `content/tz-country.json`, `web/src/engine/emergencyNumber.ts`, `web/src/components/AmbulanceBar.tsx`, `web/src/components/CountryPicker.tsx`
- Test: `content/tests/numbers.test.ts`, `web/tests/unit/emergencyNumber.test.ts`

**Interfaces:**
- Produces: table rows `{ country: "NG", name: "Nigeria", ambulance: "112", regions: [{ code: "LA", name: "Lagos", ambulance: "767" }], source: "<url>", checked: "2026-11-12" }` for at least NG, GB, US, IN, ZA, KE, GH, DE, FR, EU-generic; `detectCountry`, `numberFor`, override persistence (`t0.country`).

- [ ] **Step 1: Failing tests**: every row has `source` and `checked`; `detectCountry({ timeZone: "Africa/Lagos" })` = "NG"; `detectCountry({})` = null; `numberFor(null)` = `{ dial: "112", label: "112", country: "INT" }`; `numberFor("NG", table, "LA")` = 767; override wins over detection; bar renders `tel:` link with the dial string and the copy "📞 Call for an ambulance now".
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; the bar is in `layout.tsx` so it is on every screen; the picker is one tap from the bar ("Not your country?"). Source every row from a public page (government/ITU/EU) and date it; rows are data, not code. **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): ambulance bar with bundled, sourced emergency numbers`

---

### Task 7: Home screen, instant lane, E4, offline list (A1.1–A1.7, E4)

**Files:**
- Create: `web/src/app/page.tsx`, `web/src/components/BigButtons.tsx`, `web/src/components/WhoAndAge.tsx`, `web/src/app/list/page.tsx`, `web/src/engine/session.ts`
- Test: `web/tests/unit/session.test.ts`, `web/tests/e2e/home.spec.ts`

**Interfaces:**
- Produces: home with the §9 copy verbatim (header, sub, talk box placeholder "My dad is holding his chest and sweating…", "Or tap if it's one of these", four buttons → `/go/collapse_cpr | choking | severe_bleeding | seizure`, quiet link "It's me — I feel very unwell" → `/talk?who=me`, ambulance bar); `WhoAndAge` one-tap grid (you / someone else; baby · child · adult · pregnant · older adult; skippable; default adult) shown once after the gate, stored in `session`; `/list` renders `presentations.json` grouped alphabetically with plain titles, each → `/go/<page_id>`; `session.ts` holds `{ who, ageBand, conditions[], onsetMs, answers[], handOffLines[] }` in memory only, `reset()` on home, `copyHandOff()` the only export path.

- [ ] **Step 1: Failing tests**: session never touches `localStorage`/`sessionStorage` (spy); `copyHandOff` text contains onset + answers; e2e (Playwright, Pixel 5 emulation): home shows four buttons above the fold at 360×780, tap "Bleeding a lot" → gate card visible with "While you answer" text; buttons' bounding boxes ≥ 48 px.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run test:e2e --workspace web` → PASS. **Step 5: Commit** `feat(web): home screen, instant lane, who/age, offline list`

---

### Task 8: Service: catalogue switch and the speech endpoints (A3.8)

**Files:**
- Create: `service/src/speech/asr.ts`, `service/src/speech/tts.ts`, `service/src/speech/routes.ts`, `service/scripts/spike-speech.ts`, `service/tests/integration/speech.test.ts`, `service/RECONCILE-0.23.md` (append speech table)
- Modify: `service/src/index.ts`, `service/src/config.ts` (`speechEnabled: boolean` default false; `asrModel`, `ttsModel`), `service/src/app.ts` (mount routes when enabled; `express.raw({ type: ["audio/webm","audio/wav"], limit: "1mb" })`)

**Interfaces:**
- Produces: `createAsr({ model })` → `{ start(), stop(), transcribe(buf: Buffer, mime) → Promise<string> }` using `@qvac/sdk` `loadModel({ modelType: "whispercpp-transcription", modelSrc: WHISPER_EN_BASE_Q8_0 … })` + `transcribe({ modelId, … })`; `createTts({ model })` → `{ say(text) → Promise<Buffer /* wav */> }` via `textToSpeech` on a `tts-ggml` model (exact registry constant confirmed in the spike; Supertonic if listed, else the smallest English `tts-ggml` voice); routes: `POST /speech/transcribe` → `{ text }` (text never logged), `POST /speech/say` → `audio/wav`; both behind the Stage 0 rate limiter and a separate `createInferenceLock()` so speech never queues behind routing.

- [ ] **Step 1: Failing integration tests** with fake asr/tts injected: 1 MB + 1 byte → 413; wrong content type → 415; `/speech/say` with 401 chars → 400 "That is too long."; response has `content-type: audio/wav`; stderr captured across a transcribe round-trip never contains the fake transcript "zebra umbrella 4471"; with `SPEECH_ENABLED` unset both routes are 404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Live spike on the Mac**: `npm run spike:speech --workspace service` records nothing; it reads `tests/fixtures/hello.wav` (a 2 s sine-masked spoken "hello" committed, or generated by the TTS half first), transcribes it, synthesises "Call for an ambulance now", writes `/tmp/say.wav`, prints RSS of the worker and ms for each. Record both model ids, RAM and latency in `RECONCILE-0.23.md`. **Ruling to write if RAM of ASR+TTS+4B exceeds 5.5 GB:** speech stays `SPEECH_ENABLED=false` on the 6 GB box and the client uses on-device platform speech with the consent sheet (Task 10); flag in the results file.
- [ ] **Step 6: Commit** `feat(service): speech endpoints behind the same hardening; catalogue path from env`

---

### Task 9: Conversation lane client (A3.1–A3.5, A3.7, E3, E10, E11)

**Files:**
- Create: `web/src/lib/api.ts`, `web/src/engine/routeDecision.ts`, `web/src/engine/conversation.ts`, `web/src/app/talk/page.tsx`, `web/src/components/QuestionCard.tsx`, `web/src/components/KnownConditions.tsx`
- Test: `web/tests/unit/routeDecision.test.ts`, `conversation.test.ts`, `web/tests/e2e/talk.spec.ts`

**Interfaces:**
- Consumes: `RouteRequest`/`RouteResponse` from `web/src/data/contract.ts` (Task 3), pages data, `session`.
- Produces: `decide` and `createLane` (signatures above). Rules: on `submit`, immediately set `pageId: "holding", provisional: true, waiting: true` and render the holding page; call `POST /route` with `{ text, age_band, answers }` and a 20 s `AbortController`; `decide`: `fallback || confidence === "low" || error` → holding; else top candidate; `question` = `res.next_question` only while `asked < 3`; every answer re-submits with the accumulated `answers[]` (the service picks the next unanswered question); after 3 answers, `question: null`. UI: acknowledge line + one question per screen ("Okay. One quick question: …" Yes / No / Not sure); "Not sure" sends `"unsure"`. `KnownConditions` tap list (asthma · diabetes · heart / blood pressure · epilepsy · sickle cell · pregnancy · allergies · blood thinners · I don't know) appears after the first action is on screen, writes `session.conditions`, opens `branchesFor` on the page. The user's raw text is never echoed into any instruction (A3.7 on the client side: only page/question text from data reaches the DOM).

- [ ] **Step 1: Failing tests**

```ts
test("decide: fallback true → holding, provisional", ...);
test("decide: confidence low → holding even with candidates", ...);
test("decide: network error → holding", ...);
test("lane shows holding within 1 tick of submit, before the fetch resolves", ...);
test("lane stops asking after 3 answers", ...);
test("lane sends accumulated answers on each re-submit", ...);
test("lane times out at 20 s and lands on holding", ...);   // fake timers
```
e2e: with the service mocked via `page.route("**/route", ...)` to delay 3 s then return choking high: the holding page is visible at 500 ms, the choking page by 4 s; mocked 500 → holding, no error text in DOM.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): conversation lane with fail-safe routing and the holding page while waiting`

---

### Task 10: Speech on the client (E6, A1.2, A3.8, Q8)

**Files:**
- Create: `web/src/engine/speech.ts`, `web/src/components/TalkBox.tsx`, `web/src/components/ReadAloud.tsx`, `web/src/components/ConsentSheet.tsx`
- Test: `web/tests/unit/speech.test.ts`

**Interfaces:**
- Produces: `sttMode(env) → "service" | "platform-ondevice" | "platform-consent" | "none"`: `"platform-ondevice"` only when `SpeechRecognition` exists **and** the UA is iOS 17+ Safari (Apple documents on-device processing) — otherwise `"service"` when `NEXT_PUBLIC_SPEECH=1`, else `"platform-consent"` (shows `ConsentSheet`: "Your phone may send your voice to Google/Apple to understand it. Use it?") , else `"none"` (typing only, mic hidden). `ttsMode` → `"platform"` when `speechSynthesis` exists (local on iOS/Android), else `"service"`. `ReadAloud` button on every page reads the visible step aloud; `TalkBox` records with `MediaRecorder` (webm/opus, max 30 s) → `/speech/transcribe` → fills the text box (user can edit before sending).

- [ ] **Step 1: Failing tests**: mode table per env; recording longer than 30 s is cut; `ReadAloud` splits on sentences and speaks the current step only; audio blob is discarded after transcription (no reference retained).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): talk box, read-aloud, speech routing with consent`

---

### Task 11: Disclaimer, settings, terms, no-stay-home guard, accessibility pass (A6.1–A6.3, A7.5)

**Files:**
- Create: `web/src/components/Disclaimer.tsx`, `web/src/app/settings/page.tsx`, `web/src/app/terms/page.tsx`, `web/tests/unit/no-stay-home.test.ts`, `web/tests/e2e/a11y.spec.ts`
- Modify: `web/src/app/layout.tsx`

**Interfaces:**
- Produces: first-open modal (localStorage `t0.disclaimerSeen`): "This app gives first-aid guidance written and checked by a doctor. It always tells you to get emergency help. It is not a substitute for emergency services or a doctor." with one button "I understand"; settings: responder toggle, country override, read-aloud on/off, "Show the disclaimer again", link to terms (placeholder text marked `[COUNSEL REVIEW]`); `no-stay-home.test.ts` greps `web/src` and `service/src` for `/SELF_CARE|STAY_HOME|stay home|self-care/i` → must be zero matches outside the forbidden-words constants.

- [ ] **Step 1: Failing tests**: modal shown on first load, not on second; grep guard; axe (`@axe-core/playwright`) on home, gate, page, talk, settings: zero serious/critical violations; all tap targets ≥ 48 px; text scales with `font-size: 200%` without horizontal scroll; every icon button has an `aria-label`; `navigator.vibrate(30)` called on gate transitions when available.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): disclaimer, settings, terms placeholder, no-stay-home guard, a11y`

---

### Task 12: PWA: manifest, service worker, offline exit test (E9)

**Files:**
- Create: `web/public/manifest.webmanifest`, `web/public/icons/icon-192.png`, `icon-512.png`, `web/src/app/sw.ts`, `web/tests/e2e/offline.spec.ts`
- Modify: `web/next.config.ts` (wrap with `@serwist/next` `withSerwist({ swSrc: "src/app/sw.ts", swDest: "public/sw.js" })`), `web/src/app/layout.tsx` (manifest link, theme colour)

**Interfaces:**
- Produces: precache of the exported site (`self.__SW_MANIFEST`) + runtime cache-first for `/data/*.json`; `navigateFallback` to `/` for unknown routes; version bump on every build.

- [ ] **Step 1: Failing e2e**: load home online → `context.setOffline(true)` → reload → home renders; tap "Bleeding a lot" → gate → answer → fake page renders fully (built with `INCLUDE_FIXTURES=1`), zero failed requests in `page.on("requestfailed")`; `/talk` offline shows "You're offline. Tap a situation below instead." and the presentation list; `/list` renders offline.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(web): installable PWA with full offline cache`

---

### Task 13: Deploy the web app and wire CORS; phone exit test

**Files:**
- Create: `docs/infra/vercel.md`, `web/.env.example` (`NEXT_PUBLIC_SERVICE_URL`, `NEXT_PUBLIC_SPEECH`)
- Modify: `service/scripts/oracle/deploy.sh` (`CORS_ORIGINS` adds the Vercel origin), `docs/STAGE-0-RESULTS.md` (nothing) / `docs/STAGE-1-RESULTS.md` (create)

- [ ] **Step 1: Vercel project**: `cd web && vercel link` **with `.env.local` moved out first and restored after** (memory lesson: `vercel link/env` can clobber `.env.local`); `vercel env add NEXT_PUBLIC_SERVICE_URL production` = the service HTTPS host; `vercel --prod`. Expected: a `*.vercel.app` URL serving the PWA with Lighthouse "installable".
- [ ] **Step 2: Service CORS**: redeploy the service with `CORS_ORIGINS=https://<vercel-host>`; `curl -i -X OPTIONS https://<service>/route -H "Origin: https://<vercel-host>"` → ACAO echoes the origin; a different origin → no ACAO.
- [ ] **Step 3: Phone exit test (Dami, real phone, both OS if available)**: install to home screen; airplane mode → open → tap "Bleeding a lot" → gate → fake page renders; airplane off → "Talk" → type "my dad fell and is not answering" → holding page appears at once → collapse page follows (or holding stays, if the service is down: that is also a pass for the fallback); read-aloud works; ambulance bar shows the local number. Screenshots to `docs/images/stage-1-phone-*.png`.
- [ ] **Step 4: Write `docs/STAGE-1-RESULTS.md`**: what ran where, the speech ruling from Task 8, any Ampere update from the catcher, open items.
- [ ] **Step 5: Commit** `docs: stage 1 exit test results`

---

### Task 14: Dami signs the holding page; close the stage

**Files:**
- Modify: `content/pages/holding.json` (`author_signoff: { by: "Dami Mustapha", date: "<date>" }`), `FOR[Dami].md`, `docs/ROADMAP.md` (Stage 1 → done), `tasks/lessons.md`, `docs/context/` handoff

- [ ] **Step 1**: Dami reads `holding.json` on the phone and in the file; edits wording if needed; sets `author_signoff`. `npm run check --workspace content` → `holding.json: SIGNED`. Rebuild and redeploy (Task 13 steps 1–2).
- [ ] **Step 2**: FOR[Dami] "What Stage 1 built" (engine modules in plain words, how a page becomes screens, how the lane falls back), ROADMAP Stage 1 done line, lessons.
- [ ] **Step 3**: `npm test && npm run typecheck && npm run check --workspace content` all green; `git status` clean; commit, do not push (Dami's call).

---

## Self-review notes

- **Spec coverage:** A1.1–A1.7 → Task 7 (A1.7 mental-health crisis is a presentation row + page id placeholder; the page itself is Stage 3). E1/E2 → Task 4; E3 → Tasks 4, 9; E4 → Task 7; E5 → Task 5; E6 → Tasks 10, 11; E7 → Task 6; E8 → Task 5; E9 → Task 12; E10 → Tasks 2, 9, 14; E11 → Task 9; E12 → Task 5. A3.1–A3.5, A3.7 → Task 9; A3.8 → Tasks 8, 10. A5.3 → Task 2. A6.1–A6.3 → Task 11; A6.4 → carried from Stage 0 + Task 8. A7.1 → Tasks 4, 12, 13; A7.5 → Task 11.
- **Deviation recorded:** no SSE streaming in Stage 1. The model's output is labels, so there is nothing to stream; "provisional action appears immediately" is met by showing the holding page at submit time (Task 9). Revisit only if a measured gap in perceived latency appears on the phone.
- **Type consistency:** `Question` fields `yes_changes/no_changes` exist in the content schema but the service catalogue only needs `{id, text}` (Task 3 strips); `RouteResponse.next_question` text is the signed text from the catalogue, so the client may render it directly.
- **Proportion:** 14 tasks for ~2,500 lines of app code plus data; code blocks are tests and signatures only.
- **Dami's inputs on the critical path:** the holding-page signature (Task 14) and the phone exit test (Task 13). Everything else can proceed without him.
