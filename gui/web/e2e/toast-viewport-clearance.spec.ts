import { expect, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { withShareableProject } from "./shareableProject";

test("keeps desktop feedback at the status bar after resizing a side composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(async (projectPath) => {
    await openSuggestedPendingEdit(page, projectPath);
    await page
      .getByRole("button", { name: "Maximize timeline", exact: true })
      .click();
    const composer = page.locator(".pending-ask-thread .comment-compose");
    await composer.scrollIntoViewIfNeeded();
    const textarea = composer.locator("textarea");
    const before = await textarea.boundingBox();
    expect(before).not.toBeNull();
    if (!before) throw new Error("The native comment textarea must be visible");
    await page.mouse.move(
      before.x + before.width - 3,
      before.y + before.height - 3,
    );
    await page.mouse.down();
    await page.mouse.move(before.x + before.width - 3, 854, { steps: 25 });
    await page.mouse.up();
    await expect
      .poll(async () => (await textarea.boundingBox())?.height ?? 0)
      .toBeGreaterThan(before.height + 100);
    await page.route("**/api/pipeline/render-preview", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Bad request" }),
      }),
    );
    await page.keyboard.press("Control+b");
    const toast = page.locator(".ui-toast-region--app .ui-toast");
    await expect(toast).toBeVisible();
    await expect
      .poll(
        async () => {
          const card = await toast.boundingBox();
          const status = await page.locator(".status-bar").boundingBox();
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
    expect(card.x + card.width).toBeLessThan(field.x);
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
