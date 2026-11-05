import { expect, test } from "@playwright/test";
import { openSuggestedPendingEdit } from "./pendingEdit";
import { withShareableProject } from "./shareableProject";
import { runPaletteCommand } from "./stageNav";

test("keeps desktop feedback above the Player with a long note in the side composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await withShareableProject(async (projectPath) => {
    await openSuggestedPendingEdit(page, projectPath);
    await expect(page.getByRole("dialog", { name: "Inspector" })).toBeVisible();
    await expect(page.locator("input:focus, textarea:focus")).toHaveCount(0);
    const composer = page.locator(".edit-ask .sys-composer");
    await composer.scrollIntoViewIfNeeded();
    const textarea = composer.getByRole("textbox", { name: "Your question" });
    const before = await textarea.boundingBox();
    if (!before) throw new Error("The composer field must be visible");
    await textarea.fill(
      ["one", "two", "three", "four", "five", "six"].join("\n"),
    );
    // The system Composer cannot be dragged taller; long text scrolls inside it.
    await expect
      .poll(async () => (await textarea.boundingBox())?.height)
      .toBe(before.height);
    await textarea.evaluate((el) => el.blur());
    await page.route("**/api/pipeline/render-preview", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Bad request" }),
      }),
    );
    await runPaletteCommand(page, "Refresh mix");
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
