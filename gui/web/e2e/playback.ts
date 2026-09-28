import { expect, type Page } from "@playwright/test";
import { parseTimecodeSec } from "./timecode";

/** Play must move the transport clock past its start by more than this (s). */
export const PLAYBACK_ADVANCE_SEC = 0.25;
/** A paused clock must hold still for this long (ms). */
export const PAUSE_HOLD_MS = 600;

/** The transport's Play button (exact, so it never matches "Play from…"). */
export function playButton(page: Page) {
  return page.getByRole("button", { name: "Play", exact: true });
}

/**
 * Click Play, see the transport clock pass its start by
 * `PLAYBACK_ADVANCE_SEC`, click Pause, and see the clock hold for
 * `PAUSE_HOLD_MS`. The caller picks the audition path first (host Original,
 * guest proxies).
 */
export async function expectPlaybackAdvancesThenHolds(
  page: Page,
): Promise<void> {
  const play = playButton(page);
  const clock = page.locator("header.transport .timecode-current");
  const initial = parseTimecodeSec(await clock.innerText());
  await play.click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect
    .poll(async () => parseTimecodeSec(await clock.innerText()))
    .toBeGreaterThan(initial + PLAYBACK_ADVANCE_SEC);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(play).toBeVisible();
  const paused = parseTimecodeSec(await clock.innerText());
  await page.waitForTimeout(PAUSE_HOLD_MS);
  expect(parseTimecodeSec(await clock.innerText())).toBe(paused);
}
