import type { PlaywrightWorkerOptions } from "@playwright/test";

export type ProjectLaunchOptions = PlaywrightWorkerOptions["launchOptions"];

/**
 * `base` plus `args` appended to its own args, as a fresh object. A project's
 * `use.launchOptions` replaces the config-level object rather than merging it,
 * so compat projects extend the base config's options through this.
 */
export function withLaunchArgs(
  base: ProjectLaunchOptions | undefined,
  args: readonly string[],
): ProjectLaunchOptions {
  return { ...base, args: [...(base?.args ?? []), ...args] };
}
