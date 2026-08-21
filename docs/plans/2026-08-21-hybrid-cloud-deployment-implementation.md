# Triage-0 Hybrid Cloud Deployment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the verified local QVAC application while shipping a fully functional Vercel frontend backed by an isolated QVAC service on a new EC2 instance.

**Architecture:** Local Express continues to serve `public/` and same-origin QVAC routes. Vercel serves a generated static `dist/` build whose runtime configuration points to `/api`; Vercel rewrites `/api/*` to the dedicated HTTPS EC2 origin. The cloud backend uses the existing Express/QVAC pipeline with cloud-specific disclosure, rate limiting, and operational hardening.

**Tech Stack:** TypeScript 5.7, Node.js 22+, Express, `@qvac/sdk`, static HTML/CSS/JavaScript, Vercel static hosting and external rewrites, Ubuntu 22.04 EC2, systemd, Caddy, Node test runner, jsdom.

---

### Task 1: Establish the Baseline

**Files:**
- Verify: `package.json`
- Verify: `tests/unit/*.test.ts`
- Verify: `tests/integration/*.test.ts`

**Step 1: Install exact dependencies**

Run: `npm ci --maxsockets=1`
Expected: exit 0 with `@qvac/sdk@0.13.3` installed.

**Step 2: Run the type gate**

Run: `npm run typecheck`
Expected: exit 0.

**Step 3: Run model-free tests first**

Run: `node --import tsx --test tests/unit/frontend.test.ts tests/integration/http-validation.test.ts`
Expected: all selected tests pass without loading a model.

**Step 4: Record the baseline**

Append command results to `tasks/todo.md`. Do not change application behavior until the baseline is recorded.

---

### Task 2: Add Explicit Runtime Configuration

**Files:**
- Create: `public/runtime-config.js`
- Create: `scripts/build-web.mjs`
- Create: `tests/unit/runtime-config.test.ts`
- Modify: `public/app.html`
- Modify: `public/assets/js/triage.js`
- Modify: `package.json`

**Step 1: Write the failing runtime test**

Test that local configuration uses same-origin routes and that a generated cloud build uses `/api` plus the `cloud` label:

```ts
test("cloud build writes an explicit cloud runtime", async () => {
  const config = await buildWeb({ mode: "cloud", apiBase: "/api", outDir });
  assert.deepEqual(config, { mode: "cloud", apiBase: "/api" });
  assert.match(readFileSync(join(outDir, "runtime-config.js"), "utf8"), /mode: "cloud"/);
});
```

**Step 2: Prove the test fails**

Run: `node --import tsx --test tests/unit/runtime-config.test.ts`
Expected: FAIL because the build helper does not exist.

**Step 3: Add the local default**

Create `public/runtime-config.js`:

```js
window.TRIAGE0_RUNTIME = Object.freeze({ mode: "local", apiBase: "" });
```

Load it before `net.js` and `triage.js` in `public/app.html`.

**Step 4: Route frontend calls through one helper**

At the top of `public/assets/js/triage.js`:

```js
var runtime = window.TRIAGE0_RUNTIME || { mode: "local", apiBase: "" };
function api(path) {
  return String(runtime.apiBase || "").replace(/\/$/, "") + path;
}
```

Replace the five route calls with `api("/health")`, `api("/transcribe")`, `api("/triage")`, `api("/tts")`, and `api("/perf-log.csv")`.

**Step 5: Generate the cloud static build**

`scripts/build-web.mjs` copies `public/` to `dist/` and overwrites `dist/runtime-config.js` with:

```js
window.TRIAGE0_RUNTIME = Object.freeze({ mode: "cloud", apiBase: "/api" });
```

Add `"build:web": "node scripts/build-web.mjs"` to `package.json`.

**Step 6: Run tests**

Run: `node --import tsx --test tests/unit/runtime-config.test.ts tests/unit/frontend.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add package.json public/app.html public/runtime-config.js public/assets/js/triage.js scripts/build-web.mjs tests/unit/runtime-config.test.ts
git commit -m "feat: add explicit local and cloud runtimes"
```

---

### Task 3: Make Mode-Specific Privacy Copy Accurate

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.html`
- Modify: `public/assets/js/net.js`
- Modify: `public/assets/css/app.css`
- Modify: `tests/unit/frontend.test.ts`

**Step 1: Write failing copy tests**

Add assertions that cloud mode renders `Cloud runtime`, never `Nothing leaves this computer`, and local mode still renders `Offline` plus the zero-egress proof.

**Step 2: Prove failure**

Run: `node --import tsx --test tests/unit/frontend.test.ts`
Expected: FAIL on cloud-mode copy.

**Step 3: Implement one mode painter**

In `net.js`, expose `paintRuntimeMode()` and apply:

```js
var cloud = window.TRIAGE0_RUNTIME && window.TRIAGE0_RUNTIME.mode === "cloud";
badge.textContent = cloud ? "Cloud runtime" : "Offline";
privacy.textContent = cloud
  ? "Processed by the dedicated Triage-0 cloud runtime. Do not enter identifying patient information."
  : "Nothing leaves this computer.";
```

Update the landing page to describe both supported modes without weakening the original local claims.

**Step 4: Run tests**

Run: `node --import tsx --test tests/unit/frontend.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add public/index.html public/app.html public/assets/js/net.js public/assets/css/app.css tests/unit/frontend.test.ts
git commit -m "fix: label local and cloud privacy modes accurately"
```

---

### Task 4: Harden the Public Backend

**Files:**
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/integration/cloud-security.test.ts`

**Step 1: Write failing security-contract tests**

Cover:

- cloud health reports `deploymentMode: "cloud"`;
- only the configured frontend origin receives CORS headers;
- request limits return `429` with a fixed message;
- errors never expose filesystem paths;
- server does not persist request bodies.

**Step 2: Prove failure**

Run: `TRIAGE0_DEPLOYMENT_MODE=cloud TRIAGE0_ALLOWED_ORIGIN=https://example.vercel.app node --import tsx --test tests/integration/cloud-security.test.ts`
Expected: FAIL because cloud middleware is absent.

**Step 3: Add minimal hardening**

Add `express-rate-limit` and configure it only in cloud mode:

```ts
const cloud = process.env.TRIAGE0_DEPLOYMENT_MODE === "cloud";
const allowedOrigin = process.env.TRIAGE0_ALLOWED_ORIGIN ?? "";
```

Apply strict origin checks, `Cache-Control: no-store` to clinical responses, a conservative public request rate, the existing payload limits, and `deploymentMode` in `/health`.

Do not log case text, audio, response content, or authorization values.

**Step 4: Run model-free security tests**

Run: `TRIAGE0_DEPLOYMENT_MODE=cloud TRIAGE0_ALLOWED_ORIGIN=https://example.vercel.app node --import tsx --test tests/integration/cloud-security.test.ts tests/integration/http-validation.test.ts`
Expected: PASS.

**Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/config.ts src/server.ts package.json package-lock.json tests/integration/cloud-security.test.ts
git commit -m "feat: harden the public inference service"
```

---

### Task 5: Add Reproducible EC2 Service Assets

**Files:**
- Create: `deploy/ec2/triage-0.service`
- Create: `deploy/ec2/Caddyfile`
- Create: `deploy/ec2/bootstrap.sh`
- Create: `deploy/ec2/env.example`
- Create: `tests/unit/deploy-assets.test.ts`
- Modify: `README.md`

**Step 1: Write failing deployment-asset tests**

Assert the service runs as a non-root user, restarts on failure, binds the app to localhost, sets cloud mode, and that Caddy proxies HTTPS to `127.0.0.1:3010`.

**Step 2: Prove failure**

Run: `node --import tsx --test tests/unit/deploy-assets.test.ts`
Expected: FAIL because the files do not exist.

**Step 3: Add the systemd unit**

Use:

```ini
[Service]
User=triage0
WorkingDirectory=/opt/triage-0
EnvironmentFile=/etc/triage-0.env
ExecStart=/usr/bin/npm start
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
```

**Step 4: Add Caddy and bootstrap assets**

Caddy terminates HTTPS and proxies only the required routes. The bootstrap script installs Node 22, build tools, Vulkan/NVIDIA prerequisites where applicable, Caddy, the repository, dependencies, WHO inputs, RAG data, and the system service. It must stop on every error and never embed credentials.

**Step 5: Run tests and shell validation**

Run: `node --import tsx --test tests/unit/deploy-assets.test.ts && bash -n deploy/ec2/bootstrap.sh`
Expected: PASS.

**Step 6: Commit**

```bash
git add deploy/ec2 tests/unit/deploy-assets.test.ts README.md
git commit -m "ops: add isolated EC2 deployment assets"
```

---

### Task 6: Complete the AWS Cost and Access Gate

**Files:**
- Update: `tasks/todo.md`
- Record evidence: `docs/context/` (local and ignored)

**Step 1: Confirm AWS access method**

Use either an authenticated AWS CLI profile or the user's logged-in AWS console. Do not reuse HydraCut credentials, security groups, instance profiles, volumes, Elastic IPs, or process hosts.

**Step 2: Confirm region**

Record the selected AWS region. Do not infer it from HydraCut.

**Step 3: Compare candidates with current official prices**

Compare at least:

- CPU baseline: 4 vCPU and 16 GB RAM.
- GPU candidate: `g4dn.xlarge` or current equivalent with at least 16 GB RAM and a Vulkan-capable GPU.

Show hourly cost, estimated 730-hour monthly cost, EBS cost, Elastic IP implications, and whether the GPU quota is available.

**Step 4: Obtain the cost choice**

Do not create the instance until the user approves the exact region, instance type, and estimated monthly amount.

---

### Task 7: Provision the Dedicated Inference Host

**Files:**
- Use: `deploy/ec2/bootstrap.sh`
- Use: `deploy/ec2/triage-0.service`
- Use: `deploy/ec2/Caddyfile`

**Step 1: Create isolated infrastructure**

Create a new instance, 40 GB encrypted gp3 volume, dedicated security group, and dedicated Elastic IP. SSH is restricted to the user's current IP or replaced with SSM. Only HTTPS is public.

**Step 2: Validate the host before installing**

Run:

```bash
node --version
npx @qvac/cli doctor --json
free -h
df -h
vulkaninfo --summary
```

Expected: supported Linux architecture, Node requirement met, adequate memory/disk, and GPU or documented CPU fallback.

**Step 3: Install and ingest**

Run the reviewed bootstrap script, fetch WHO documents only from the official recorded URLs, ingest the RAG corpus, prewarm models, and start `triage-0.service`.

**Step 4: Verify locally on the host**

Run:

```bash
curl -fsS http://127.0.0.1:3010/health
curl -fsS https://$TRIAGE0_API_HOST/health
```

Expected: HTTP 200, cloud mode, healthy citation sidecar, live RAG, and resident model state.

**Step 5: Run one clinical smoke case and abstention case**

Verify citation-first SSE order, a WHO-cited plan, and an UNKNOWN result for an unsupported query. Save no patient-identifying input.

---

### Task 8: Configure and Deploy Vercel

**Files:**
- Create: `vercel.json`
- Use: `dist/`
- Modify: `README.md`

**Step 1: Add static and proxy configuration**

Create:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build:web",
  "outputDirectory": "dist",
  "cleanUrls": true,
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://TRIAGE0_API_HOST/:path*" }
  ]
}
```

Replace `TRIAGE0_API_HOST` with the verified HTTPS hostname before commit. Do not rewrite `/.well-known/*`, because Vercel reserves that path for static ownership files.

**Step 2: Test a preview deployment**

Run: `vercel --yes`
Expected: preview build succeeds; `/`, `/app`, static assets, and `/api/health` return 200.

**Step 3: Verify streamed inference through Vercel**

Confirm the backend emits the first SSE frame within Vercel's 120-second external-origin window and continues emitting often enough to keep the proxy alive.

**Step 4: Inspect desktop and mobile UI**

Capture the landing page, input state, result state, cloud-mode disclosure, and failure state. Confirm no local-only privacy claim appears in cloud mode.

**Step 5: Deploy production**

Run: `vercel --prod --yes`
Expected: production alias assigned and all live checks pass.

**Step 6: Commit**

```bash
git add vercel.json README.md
git commit -m "ops: deploy Triage-0 web and cloud proxy"
```

---

### Task 9: Run the Full Release Gate

**Files:**
- Update: `tasks/todo.md`
- Update: `FOR[Dami].md`
- Record: `docs/context/` (local and ignored)

**Step 1: Run local gates**

Run: `npm run typecheck && npm test`
Expected: all non-skipped tests pass; any environment-dependent skip is disclosed exactly.

**Step 2: Run live cloud gates**

Verify:

- `GET /` and `/app` return 200;
- `/api/health` reports cloud mode;
- a supported case streams citation, reasoning, card, plan, and done;
- an unsupported case abstains;
- rate limiting, payload limits, and sanitized errors work;
- local-only privacy claims do not appear;
- HydraCut remains healthy and was never modified.

**Step 3: Update educational documentation**

Explain the local/cloud split, Vercel proxy, EC2 isolation, QVAC resource model, cost controls, and safe operating procedure in `FOR[Dami].md`.

**Step 4: Commit**

```bash
git add FOR\[Dami\].md
git commit -m "docs: explain the hybrid Triage-0 deployment"
```

---

### Task 10: Finish the Orynth Listing

**Files:**
- Create at verification time: `public/.well-known/ory-verify.txt`
- Update: `docs/context/` and `docs/prompts/` locally

**Step 1: Use the production Vercel URL for the product website**

Do not claim the cloud session is on-device or zero-egress. Describe both supported modes clearly.

**Step 2: Complete all 13 pages**

Use the audited name, pitch, differentiators, logo, screenshot order, categories, GitHub, YouTube demo, and a professional first launch comment.

**Step 3: Add Orynth's exact verification file**

Place the downloaded token at `public/.well-known/ory-verify.txt`, rebuild, and deploy production.

**Step 4: Verify ownership evidence**

Confirm the public verification URL returns HTTP 200 and matches the downloaded source byte-for-byte before asking the user to click **Verify ownership**.

