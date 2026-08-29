import { defineConfig } from "@playwright/test";

// The image ships Chromium at a fixed path; the pinned @playwright/test version does not
// necessarily match it, so the browser is named explicitly rather than downloaded.
const CHROMIUM = process.env.LAQTA_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export default defineConfig({
  testDir: "tests/gate",
  // The airplane test deliberately spends real time offline. That is the point of it.
  timeout: 20 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8788",
    launchOptions: {
      executablePath: CHROMIUM,
      args: [
        // The container runs as root, where Chromium refuses to start sandboxed.
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        // Chromium does not honour no_proxy the way curl does, and this environment sets an
        // egress proxy. Without this the browser tries to tunnel localhost through it and hangs.
        "--no-proxy-server",
      ],
    },
    // The proxy in this environment must not sit between the browser and localhost.
    ignoreHTTPSErrors: true,
  },
  webServer: [
    {
      command: "node tests/gate/phase-1/mock-api.mjs",
      port: 8787,
      reuseExistingServer: true,
      stdout: "ignore",
    },
    {
      command: "node tests/gate/phase-1/static-server.mjs",
      port: 8788,
      reuseExistingServer: true,
      stdout: "ignore",
    },
  ],
});
