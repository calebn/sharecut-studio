import { expect, type Page } from "@playwright/test";

/** Seconds from a timecode or ruler label: `ss`, `mm:ss.mmm` or `hh:mm:ss`. */
export function parseTimecodeSec(text: string): number {
  return text
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

/** Switch the phone shell to Timeline and wait for the loaded arrange view. */
export async function openPhoneTimeline(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Timeline" })
    .click();
  // The loading skeleton also draws lanes, with the headers outside the
  // scroller; the loaded view nests them in it.
  await expect(page.locator(".timeline-scroll .track-headers")).toBeVisible();
}
