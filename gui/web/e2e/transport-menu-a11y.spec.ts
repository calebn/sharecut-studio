import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("compact transport menu accessibility", () => {
  test.use({ viewport: { width: 800, height: 844 } });

  test("has accessible audition and layer controls with touch targets", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Transport menu" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();

    const audition = menu.getByRole("group", { name: "Audition" });
    const radios = audition.getByRole("menuitemradio");
    await expect(radios).toHaveCount(3);
    await expect(radios.nth(0)).toHaveAccessibleName("Mix");
    await expect(radios.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(0)).toBeEnabled();

    await radios.nth(0).focus();
    await expect(radios.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(radios.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(radios.nth(0)).toBeFocused();

    const layers = menu.getByRole("menuitemcheckbox");
    await expect(layers).toHaveCount(4);
    const controls = [...(await radios.all()), ...(await layers.all())];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await expectPageAxeClean(page, "#transport-overflow-menu");
  });
});
