import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke tests against a running app (default http://localhost:3210).
 *   npm run dev            # in another terminal
 *   npm run test:e2e
 * Uses the locally installed Google Chrome (channel "chrome"); set E2E_CHANNEL="" to use Playwright's Chromium.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3210",
    channel: process.env.E2E_CHANNEL === undefined ? "chrome" : process.env.E2E_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.E2E_CHANNEL === undefined ? "chrome" : undefined } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: process.env.E2E_CHANNEL === undefined ? "chrome" : undefined }, testMatch: /mobile\.spec\.ts/ },
  ],
});
