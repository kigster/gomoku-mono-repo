import { defineConfig, devices } from "@playwright/test";

// Playwright e2e — the TRUE two-human harness.
//
// Unlike the Cypress multiplayer spec (which time-multiplexes one browser
// context by swapping the JWT), Playwright opens two real BrowserContexts
// that run concurrently. Each is an independent "incognito browser" with its
// own session, so a move made by one player propagates to the other through
// the live app (today: the polling hook) with no reload or JWT swap — a
// genuine human-vs-human game.
//
// Targets the local cluster started by `bin/gctl start` (vite on :5173 which
// proxies /multiplayer, /auth, … to the FastAPI on :8000). Override with
// PW_BASE_URL / PW_API_BASE / PW_DB_URL to aim at another deployment.

const baseURL =
  process.env.PW_BASE_URL || process.env.CYPRESS_BASE_URL || "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e-pw",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    actionTimeout: 15_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
