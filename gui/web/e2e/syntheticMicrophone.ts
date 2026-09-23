import type { Page } from "@playwright/test";

export type SyntheticMicrophoneOptions = {
  /**
   * Hide `navigator.permissions` so the page takes the Safari branch where
   * `permissions.query({ name: "microphone" })` is unavailable
   * (`src/record/micPermission.ts`). Leave false to keep the engine's native
   * Permissions API.
   */
  removePermissionsApi?: boolean;
};

type SyntheticMicrophoneWindow = Window & { __gumStubCalled?: boolean };

/**
 * Browser-side half of {@link stubSyntheticMicrophone}. Exported so unit tests
 * can run it against a fake window; Playwright serializes it into the page.
 */
export function installSyntheticMicrophone({
  removePermissionsApi,
}: Required<SyntheticMicrophoneOptions>): void {
  if (removePermissionsApi) {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: undefined,
    });
  }
  let ctx: AudioContext | null = null;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      // A live 440 Hz track, so level meters read a non-zero signal without
      // host microphone hardware or a native permission prompt.
      getUserMedia: async (): Promise<MediaStream> => {
        (window as SyntheticMicrophoneWindow).__gumStubCalled = true;
        ctx ??= new AudioContext();
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        const destination = ctx.createMediaStreamDestination();
        osc.connect(destination);
        osc.start();
        return destination.stream;
      },
      enumerateDevices: async (): Promise<MediaDeviceInfo[]> => [],
    },
  });
}

/**
 * Replace `navigator.mediaDevices` with a synthetic oscillator microphone in
 * every engine (Chromium, WebKit, branded Chrome).
 */
export async function stubSyntheticMicrophone(
  page: Page,
  options: SyntheticMicrophoneOptions = {},
): Promise<void> {
  await page.addInitScript(installSyntheticMicrophone, {
    removePermissionsApi: options.removePermissionsApi ?? false,
  });
}

/** True once the page has requested the synthetic microphone. */
export async function syntheticMicrophoneRequested(
  page: Page,
): Promise<boolean> {
  return page.evaluate(
    () => (window as SyntheticMicrophoneWindow).__gumStubCalled ?? false,
  );
}
