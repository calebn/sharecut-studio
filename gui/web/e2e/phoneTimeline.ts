import { expect, type Page } from "@playwright/test";

/** Switch the phone shell to Timeline and wait for the loaded arrange view. */
export async function openPhoneTimeline(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Timeline" })
    .click();
  // While the project loads, the skeleton draws busy header rows (no chips)
  // in the same place; wait for the loaded ones.
  await expect(
    page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
  ).toBeVisible();
}
