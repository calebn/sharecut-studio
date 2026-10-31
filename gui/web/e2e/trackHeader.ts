import type { Locator, Page } from "@playwright/test";

/** A track's header, the root of the stage `TrackHeader` part. */
export const TRACK_HEADER = ".track-headers .sys-track";

/** The select button of every header: it selects the track and opens its details. */
export const TRACK_HEADER_SELECT = ".track-headers .sys-track-main";

/** The select button of the header named `label`; the name is the track's, exactly. */
export function trackHeaderButton(scope: Page | Locator, label: string) {
  return scope
    .locator(".track-headers")
    .getByRole("button", { name: label, exact: true });
}

/** The select button of every header, in column order. */
export function trackHeaderButtons(scope: Page | Locator): Locator {
  return scope.locator(TRACK_HEADER_SELECT);
}

/** The header that holds `inner`. */
export function trackHeaderOf(inner: Locator): Locator {
  return inner.locator("xpath=ancestor::*[contains(@class,'sys-track')][1]");
}
