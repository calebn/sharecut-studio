#!/usr/bin/env node
import { build } from "vite";
import { forbidE2eHooks } from "./check-bundle-no-e2e.ts";
import { forbidStoryModules } from "./check-bundle-no-stories.ts";

await build({
  plugins: [
    forbidStoryModules(),
    ...(process.env.VITE_SHARECUT_E2E === "1" ? [] : [forbidE2eHooks()]),
  ],
});
