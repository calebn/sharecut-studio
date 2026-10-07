/**
 * The More hub's Add to Home Screen hint (#1077). iOS gives web pages no way
 * to hide Safari's bars; opened from the Home Screen, Sharecut runs as a web
 * app with no browser chrome (`manifest.webmanifest`, `display: standalone`).
 */

/** What the browser reports about itself; `standalone` exists only on iOS. */
export interface HomeScreenEnv {
  standalone: boolean | undefined;
  maxTouchPoints: number;
  displayModeBrowser: boolean;
}

export const HOME_SCREEN_HINT =
  "In Safari's Share menu, choose Add to Home Screen to open Sharecut full screen.";

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
