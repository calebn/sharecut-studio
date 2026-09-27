import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("Clip inspector join control", () => {
  test("is axe-clean with a left neighbour and keeps focus order", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const lanes = page.locator(".lane-row");
    await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    // Shift+ArrowRight nudges the playhead 5 s; Mod+K splits the dialogue tracks there.
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(lanes.first().locator(".clip-block")).toHaveCount(2);
    try {
      await lanes.first().locator(".clip-block").nth(1).click();
      const joinMode = page.getByLabel("Join mode");
      await expect(joinMode).toBeVisible();
      await expectPageAxeClean(page, ".inspector");
      await page.getByLabel("Join length ms").fill("30");
      await joinMode.focus();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Join length ms")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Apply length" }),
      ).toBeFocused();
      await expectPageAxeClean(page, ".inspector");
    } finally {
      // Leave the shared live E2E project as later specs expect it.
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+Z");
      await expect(lanes.first().locator(".clip-block")).toHaveCount(1);
    }
  });
});
