import { defineConfig, devices } from "@playwright/test";

// Web E2E smoke config. Assumes the full stack is already up (make relay-up):
// web on :3000, api on :3001. We do NOT start a webServer here — the smoke is
// meant to run against the real running stack, not a throwaway prod build, so
// the dock talks to a live API (register → token → /app).
//
// Run:  cd web && bunx playwright test tests/e2e/dock-smoke.spec.ts
export default defineConfig({
  testDir: "./tests/e2e",
  // One retry absorbs the odd first-paint / HMR jitter without masking a real
  // regression (a genuinely broken dock fails both attempts).
  retries: 1,
  // Keep it serial + single-worker: the smoke registers a fresh user and drives
  // one browser; parallelism buys nothing and only muddies failure output.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    headless: true,
    // Capture evidence only when a test fails — cheap on green runs.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
