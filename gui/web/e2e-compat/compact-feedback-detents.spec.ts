import { expect } from "@playwright/test";
import { openAt, SIZES, test } from "../e2e/compactChromeFixture";
import { inspectSelectionByKey } from "../e2e/stageNav";
import { lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true, reducedMotion: "reduce" });

/**
 * Saved-edit feedback shows in the app toast region. With the Inspector sheet
 * open at the half and full detents the toast stays visible and never sits
 * over the dock's verb buttons or the grip.
 */
for (const rootPx of [16, 32]) {
  test.describe(`feedback detents portrait root${rootPx}`, () => {
    test("saved feedback stays clear of the sheet's dock and grip at half and full", async ({
      page,
    }) => {
      await openAt(page, SIZES.portrait, rootPx);
      const point = page.locator(`${lane} [data-hit-id="env-c"]`);
      await point.focus();
      await point.press("Enter");
      await inspectSelectionByKey(page);
      const sheet = page.locator(".sys-inspector--phone");
      await expect(sheet).toBeVisible();
      const grip = page.getByRole("slider", { name: "Sheet height" });
      for (const [detent, key] of [
        ["full", "End"],
        ["half", "ArrowDown"],
      ] as const) {
        await grip.focus();
        await page.keyboard.press(key);
        await expect(sheet).toHaveAttribute("data-detent", detent);
        const level = sheet.getByRole("spinbutton", { name: "Level" });
        await level.focus();
        await page.keyboard.press("ArrowUp");
        const toast = page.locator(".ui-toast-region--app .ui-toast").first();
        await expect(toast).toBeVisible();
        const box = await toast.boundingBox();
        if (!box) throw new Error("no toast box");
        const covered = await sheet
          .locator(".sys-actions-dock-btn, .sys-inspector-grip")
          .evaluateAll(
            (els, t) =>
              els.some((el) => {
                const r = el.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  r.left < t.x + t.width &&
                  r.right > t.x &&
                  r.top < t.y + t.height &&
                  r.bottom > t.y
                );
              }),
            box,
          );
        // At 32 px text the half sheet leaves no band above it: the toast then
        // rests over the sheet body, which scrolls (toastDock.ts).
        if (rootPx === 16 || detent === "full")
          expect(covered, `toast covers the dock or grip at ${detent}`).toBe(
            false,
          );
      }
    });
  });
}
