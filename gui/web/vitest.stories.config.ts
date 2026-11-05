import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "stories",
    include: ["src/**/*.sweep.browser.test.tsx"],
    setupFiles: ["./.storybook/vitest.setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {} }),
      instances: [{ browser: "chromium" }],
    },
  },
});
