import type { PlaywrightWorkerOptions } from "@playwright/test";

export type BrowserName = PlaywrightWorkerOptions["browserName"];

export type StudioAxeOwnership =
  | { suite: "main" }
  | { suite: "compat"; engine: BrowserName };

export function ownsStudioAxe(owner: StudioAxeOwnership): boolean {
  return owner.suite === "main" || owner.engine === "webkit";
}
