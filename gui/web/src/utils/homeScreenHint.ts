/**
 * The Add to Home Screen hint (#1077). iPhone Safari gives web pages no way
 * to hide its bars: no `minimal-ui` since iOS 8, a Fullscreen API for video
 * only, and it collapses them only while the document itself scrolls, which
 * the fixed app shell never does. Opened from the Home Screen, ShareCut runs
 * as a web app with no browser chrome (`manifest.webmanifest`,
 * `display: standalone`), so that is the phone's full-screen path. Home offers
 * it as one card from the second visit on, until it is dismissed on this
 * device; it never shows inside a project.
 */
import { readLocal, writeLocal } from "./storage";

/** What the browser reports about itself; `standalone` exists only on iOS. */
export interface HomeScreenEnv {
  standalone: boolean | undefined;
  maxTouchPoints: number;
  displayModeBrowser: boolean;
}

/** Per browser, like the other `sharecut.*` conveniences: not project state. */
export const HOME_SCREEN_HINT_DISMISSED_KEY =
  "sharecut.homeScreenHintDismissed";

/** True in an iPhone or iPad Safari tab, not once ShareCut runs from the Home Screen. */
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

/** Per device: how many times Home has opened, so the card waits for a second visit. */
export const HOME_VISITS_KEY = "sharecut.homeVisits";

let visitsBefore: number | null = null;

/**
 * Counts this Home visit once per page load and returns the visits before it.
 * Blocked storage counts nothing, so the card stays away rather than showing
 * on every visit.
 */
export function countHomeVisit(): number {
  if (visitsBefore !== null) return visitsBefore;
  const parsed = Number.parseInt(readLocal(HOME_VISITS_KEY) ?? "", 10);
  visitsBefore = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  writeLocal(HOME_VISITS_KEY, String(visitsBefore + 1));
  return visitsBefore;
}

/** Forgets the count held for this page load (tests). */
export function _resetHomeVisitCountForTests(): void {
  visitsBefore = null;
}

/** True when the card is due: a Safari tab, a visit after the first, and not dismissed. */
export function homeScreenHintDue(
  env: HomeScreenEnv,
  priorVisits: number,
): boolean {
  return (
    offersHomeScreenHint(env) && priorVisits >= 1 && !homeScreenHintDismissed()
  );
}

/** True once the card was dismissed on this device. */
export function homeScreenHintDismissed(): boolean {
  return readLocal(HOME_SCREEN_HINT_DISMISSED_KEY) === "1";
}

export function dismissHomeScreenHint(): void {
  writeLocal(HOME_SCREEN_HINT_DISMISSED_KEY, "1");
}
