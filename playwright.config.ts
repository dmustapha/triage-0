import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/quality",
  timeout: 300_000, // 5 min per test — first triage loads model (cold start ~60s)
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1, // Serial only — inference engine is single-job
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "tests/quality/results.json" }]],
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  use: {
    baseURL: "http://localhost:5062",
    headless: true,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
  },
});
