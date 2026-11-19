import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({...base,
  testMatch: "**/independent-3915.spec.ts", retries:0, workers:1,
  reporter:[["./e2e/independent3915-reporter.ts"]],
  use:{...base.use,trace:"off",screenshot:"off",video:"off"},
});
