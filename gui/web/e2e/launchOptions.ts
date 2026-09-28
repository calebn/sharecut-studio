import type { PlaywrightWorkerOptions } from "@playwright/test";

export type ProjectLaunchOptions = PlaywrightWorkerOptions["launchOptions"];

/**
 * Chromium's built-in fake capture device and auto-accepted media prompt, so
 * recording specs call the real `getUserMedia` (then the keeper AudioWorklet,
 * OPFS writer and upload) with no hardware or permission prompt. Specs that
 * stub `navigator.mediaDevices` are unaffected.
 */
export const CHROMIUM_FAKE_MEDIA_ARGS: readonly string[] = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

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
