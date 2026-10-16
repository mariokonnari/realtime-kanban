import { defineConfig, devices } from "@playwright/test";
import { WEB_PORT, WEB_URL, WS_URL } from "./support/env";

// Browser tests against localhost services only: the web app is built here with
// NEXT_PUBLIC_WS_URL pointing at the test server (Next inlines it at build time,
// it is not read at run time), then served by `next start`; each test starts the
// real WebSocket server itself (support/server.ts) on a throwaway database.

export default defineConfig({
  testDir: "./tests",
  // One test at a time: they share the web server and, more to the point, the one
  // fixed port the web build points the WebSocket at.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next build` writes apps/web/.next, so the app built here replaces any earlier build there.
    command: `npm run build --workspace=apps/web && npm run start --workspace=apps/web -- --hostname 127.0.0.1 --port ${WEB_PORT}`,
    cwd: "../..",
    url: WEB_URL,
    env: { NEXT_PUBLIC_WS_URL: WS_URL },
    // Never adopt a server that is already there: it may be someone's dev build pointing somewhere else.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
