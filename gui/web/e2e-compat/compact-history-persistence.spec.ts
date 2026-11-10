import { expect } from "@playwright/test";
import { openAt, railHistory, SIZES, test } from "../e2e/compactChromeFixture";
import { newFinger } from "../e2e/finger";
import { inspectSelection } from "../e2e/stageNav";
import { centerOf, lane } from "../e2e/touchTimeline";

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

/**
 * Undo and Redo live in the App header on the phone, not in the Inspector
 * sheet, so an open sheet at any detent and any text size leaves them in view
 * and under the finger.
 */
for (const name of ["portrait", "landscape"] as const) {
  for (const rootPx of [16, 32]) {
    {
      test.describe(`history ${name} root${rootPx}`, () => {
        test("Undo and Redo stay reachable in the App header with the Inspector sheet open", async ({
          page,
          context,
          browserName,
        }) => {
          await openAt(page, SIZES[name], 16);
          const finger = await newFinger(context, page, browserName);
          await finger.down(
            await centerOf(page, `${lane} [data-hit-id="env-c"]`),
          );
          await page.waitForTimeout(60);
          await finger.up();
          await inspectSelection(page);
          const sheet = page.locator(".sys-inspector--phone");
          await expect(sheet).toBeVisible();
          await page.evaluate((px) => {
            document.documentElement.style.fontSize = `${px}px`;
          }, rootPx);
          await page.waitForTimeout(400);
          const takeover = page.locator(".sys-inspector-takeover");
          if (await takeover.isVisible()) {
            // Too short for any sheet at this text size: the Inspector takes
            // the screen and has no height grip to persist.
            await expect(
              takeover.getByRole("button", { name: "Done" }),
            ).toBeVisible();
            return;
          }
          const grip = page.getByRole("slider", { name: "Sheet height" });
          for (const key of ["End", "Home"]) {
            await grip.focus();
            await page.keyboard.press(key);
            await page.waitForTimeout(400);
            for (const button of ["Undo", "Redo"]) {
              const control = railHistory(page).getByRole("button", {
                name: button,
              });
              await expect(control).toBeVisible();
              const box = await control.boundingBox();
              if (!box) throw new Error(`no ${button} box`);
              expect(box.width).toBeGreaterThanOrEqual(43.5);
              expect(box.height).toBeGreaterThanOrEqual(43.5);
              const topmost = await control.evaluate((el) => {
                const r = el.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  r.left + r.width / 2,
                  r.top + r.height / 2,
                );
                return hit === el || el.contains(hit);
              });
              expect(topmost, `${button} is not covered`).toBe(true);
            }
          }
          await expect(
            sheet.getByRole("group", { name: "Undo and redo" }),
          ).toHaveCount(0);
        });
      });
    }
  }
}
