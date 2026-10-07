/**
 * The Add to Home Screen hint (#1077). iPhone Safari gives web pages no way
 * to hide its bars: no `minimal-ui` since iOS 8, a Fullscreen API for video
 * only, and it collapses them only while the document itself scrolls, which
 * the fixed app shell never does. Opened from the Home Screen, Sharecut runs
 * as a web app with no browser chrome (`manifest.webmanifest`,
 * `display: standalone`), so that is the phone's full-screen path. A Safari
 * tab shows the hint as a banner until it is dismissed in that browser; More
 * keeps it as a quiet line.
 */
import { readLocal, writeLocal } from "./storage";

/** What the browser reports about itself; `standalone` exists only on iOS. */
export interface HomeScreenEnv {
  standalone: boolean | undefined;
  maxTouchPoints: number;
  displayModeBrowser: boolean;
}

export const HOME_SCREEN_HINT =
  "In Safari's Share menu, choose Add to Home Screen to open Sharecut full screen.";

/** Per browser, like the other `sharecut.*` conveniences: not project state. */
export const HOME_SCREEN_HINT_DISMISSED_KEY =
  "sharecut.homeScreenHintDismissed";

/** True in an iPhone or iPad Safari tab, not once Sharecut runs from the Home Screen. */
export function offersHomeScreenHint(env: HomeScreenEnv): boolean {
  return (
    env.standalone === false && env.maxTouchPoints > 0 && env.displayModeBrowser
  );
}

export function readHomeScreenEnv(): HomeScreenEnv {
  const nav = globalThis.navigator as
    | (Navigator & { standalone?: boolean })
    | undefined;
  return {
    standalone: nav?.standalone,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    displayModeBrowser:
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(display-mode: browser)").matches,
  };
}

/** True once the banner was dismissed in this browser. */
export function homeScreenHintDismissed(): boolean {
  return readLocal(HOME_SCREEN_HINT_DISMISSED_KEY) === "1";
}

export function dismissHomeScreenHint(): void {
  writeLocal(HOME_SCREEN_HINT_DISMISSED_KEY, "1");
}
