import { defineConfig } from "@playwright/test";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://localhost:5374",
    headless: true,
    launchOptions: {
      executablePath: chromePath,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @vibe-local-wasm/agentos run start",
      url: "http://127.0.0.1:6520",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm dev",
      url: "http://localhost:5374",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
