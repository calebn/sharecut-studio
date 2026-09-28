import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Join badge popover", () => {
  test("the join badge opens a popover that changes the join mode", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lane = page.locator(".lane-row").first();
    const clips = lane.locator(".clip-block");
    await expect(clips).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(clips).toHaveCount(2);
    let modeChanged = false;
    try {
      const badge = lane.getByRole("button", { name: /join at/ });
      await badge.click();
      const popover = page.getByRole("dialog", { name: /join at/ });
      await expect(popover).toBeVisible();
      await expect(badge).toHaveAttribute("aria-expanded", "true");
      await expectPageAxeClean(page, ".join-popover");
      await popover
        .getByRole("button", { name: "Crossfade", exact: true })
        .click();
      await expect(lane.locator(".join-badge--crossfade")).toHaveCount(1);
      modeChanged = true;
      await expect(
        popover.getByRole("button", { name: "Crossfade", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        popover.getByRole("slider", { name: "Length" }),
      ).toBeVisible();
      await expect(
        popover.getByRole("button", { name: "Audition join" }),
      ).toBeVisible();
      await expectPageAxeClean(page, ".join-popover");
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await expect(badge).toBeFocused();
    } finally {
      await page.keyboard.press("Escape");
      if (modeChanged) {
        await page.keyboard.press("ControlOrMeta+Z");
        await expect(lane.locator(".join-badge--crossfade")).toHaveCount(0);
      }
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(clips).toHaveCount(1);
    }
  });
});
