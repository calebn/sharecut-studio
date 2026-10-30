import { expect, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { withShareableProject } from "./shareableProject";

test("keeps desktop feedback above the Player after resizing a side composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(async (projectPath) => {
    await openSuggestedPendingEdit(page, projectPath);
    const composer = page.locator(".pending-ask-thread .comment-compose");
    await composer.scrollIntoViewIfNeeded();
    const textarea = composer.locator("textarea");
    const settled = async () => {
      let last = await textarea.boundingBox();
      await expect
        .poll(
          async () => {
            const now = await textarea.boundingBox();
            const still =
              !!now &&
              !!last &&
              now.x === last.x &&
              now.y === last.y &&
              now.width === last.width &&
              now.height === last.height;
            last = now;
            return still;
          },
          { timeout: 2_000 },
        )
        .toBe(true);
      if (!last) throw new Error("The native comment textarea must be visible");
      return last;
    };
    const before = await settled();
    await expect(async () => {
      await textarea.evaluate((el) =>
        el.scrollIntoView({ block: "center", inline: "nearest" }),
      );
      const grip = await settled();
      const x = grip.x + grip.width - 3;
      const y = grip.y + grip.height - 3;
      const gripFree = await textarea.evaluate(
        (el, [px, py]) => document.elementFromPoint(px, py) === el,
        [x, y],
      );
      expect(gripFree).toBe(true);
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        await page.mouse.move(x, 854, { steps: 25 });
      } finally {
        await page.mouse.up();
      }
      const height = (await textarea.boundingBox())?.height ?? 0;
      expect(height).toBeGreaterThan(before.height + 100);
    }).toPass({ timeout: 15_000 });
    await page.route("**/api/pipeline/render-preview", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Bad request" }),
      }),
    );
    // The Inspector card moves focus into its display-name field, and shortcuts
    // are not heard while typing.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("Control+b");
    const toast = page.locator(".ui-toast-region--app .ui-toast");
    await expect(toast).toBeVisible();
    await expect
      .poll(
        async () => {
          const card = await toast.boundingBox();
          const status = await page
            .locator(".stage-frame-player")
            .boundingBox();
          return card && status
            ? Math.abs(card.y + card.height - (status.y - 8))
            : Infinity;
        },
        { timeout: 3_000 },
      )
      .toBeLessThan(1);
    const card = await toast.boundingBox();
    const field = await composer.boundingBox();
    expect(card).not.toBeNull();
    expect(field).not.toBeNull();
    if (!card || !field)
      throw new Error("Feedback and the side composer must remain visible");
    // The Inspector card holds the composer at the left of the stage, so the
    // feedback may sit on either side of it; it must clear it horizontally.
    expect(
      card.x + card.width <= field.x || card.x >= field.x + field.width,
    ).toBe(true);
    const overlapWidth = Math.max(
      0,
      Math.min(card.x + card.width, field.x + field.width) -
        Math.max(card.x, field.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(card.y + card.height, field.y + field.height) -
        Math.max(card.y, field.y),
    );
    expect(overlapWidth * overlapHeight).toBe(0);
  });
});
