import type { Page } from "@playwright/test";

/** Lanes default to Fit; a spec that needs one stable height pins the stored fixed preference before the page loads. */
export async function pinFixedLaneHeight(page: Page, px = 104): Promise<void> {
  await page.addInitScript((height) => {
    localStorage.setItem(
      "sharecut.laneHeight",
      JSON.stringify({ mode: "fixed", px: height }),
    );
  }, px);
}
