import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
} from "@playwright/test";

/**
 * WebKit's real `getUserMedia` needs an explicit grant; without it the
 * microphone stays blocked and keeper capture never starts (#704). Chromium
 * specs instead run with `CHROMIUM_FAKE_MEDIA_ARGS` (`launchOptions.ts`),
 * which auto-grants at launch, so this is WebKit/browser-context-scoped.
 */
export const RECORDER_CONTEXT: BrowserContextOptions = {
  permissions: ["microphone"],
};

/** What `withBrowserPages`/`withTwoBrowserPages` need from a browser. */
export type BrowserContextSource = Pick<Browser, "newContext">;

/**
 * A context source for `withBrowserPages`, engine-aware for keeper pages.
 *
 * On Chromium (and Firefox), `browser.newContext()` is used as-is. On
 * WebKit, that same ephemeral context rejects
 * `navigator.storage.getDirectory()` with `UnknownError`, which the keeper
 * OPFS writer depends on; `browserType.launchPersistentContext("")` (an
 * empty `userDataDir` is Playwright's own ephemeral-persistent-context
 * idiom — no profile written to disk) does not have that gap, including for
 * `createSyncAccessHandle` inside a worker. The app needs no change for
 * this: it is purely a harness gap.
 */
export function keeperContextSource(browser: Browser): BrowserContextSource {
  const browserType = browser.browserType();
  if (browserType.name() !== "webkit") {
    return browser;
  }
  return {
    newContext: (options?: BrowserContextOptions): Promise<BrowserContext> =>
      browserType.launchPersistentContext("", options ?? {}),
  };
}
