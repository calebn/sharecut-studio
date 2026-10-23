import { expect, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";

test.use({ hasTouch: true, storageState: { cookies: [], origins: [] } });

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`Listen menu keeps actions usable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await page
        .locator(".listen-hero")
        .getByRole("button", { name: "Menu" })
        .click();
      const menu = page.getByRole("menu", { name: "Transport menu" });
      await expect(
        menu.getByRole("menuitem", { name: /Export deliverables/ }),
      ).toBeVisible();
      const share = menu.getByRole("menuitem", { name: /Share/ });
      if (await share.count()) await expect(share).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: /Remove track/ }),
      ).toHaveCount(0);
      await expect(
        menu.getByRole("menuitem", { name: /Move track/ }),
      ).toHaveCount(0);
      await expect(menu.getByRole("group", { name: "Zoom" })).toHaveCount(0);
      const shortcutsVisible = await menu
        .locator(".ui-menu-shortcut")
        .evaluateAll((items) =>
          items.some((item) => getComputedStyle(item).display !== "none"),
        );
      expect(shortcutsVisible).toBe(false);
      const rowHeights = await menu
        .locator(
          '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
        )
        .evaluateAll((rows) =>
          rows.map((row) => row.getBoundingClientRect().height),
        );
      expect(rowHeights.length).toBeGreaterThan(0);
      expect(Math.min(...rowHeights)).toBeGreaterThanOrEqual(44 - 0.001);
      const lastAction = menu.getByRole("menuitem", {
        name: "Commands and shortcuts",
      });
      await lastAction.scrollIntoViewIfNeeded();
      const menuBounds = await menu.boundingBox();
      const actionBounds = await lastAction.boundingBox();
      expect(menuBounds).not.toBeNull();
      expect(actionBounds).not.toBeNull();
      if (menuBounds && actionBounds) {
        expect(actionBounds.y).toBeGreaterThanOrEqual(menuBounds.y);
        expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(
          menuBounds.y + menuBounds.height + 1,
        );
      }
    });
  });
}
