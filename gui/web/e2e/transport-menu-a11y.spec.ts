import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test.describe("compact transport menu accessibility", () => {
  test.use({ viewport: { width: 800, height: 844 } });

  test("has accessible audition, layer and action rows with touch targets", async ({
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

    // Menu radios keep menu paint (not the fixed-dark transport segment) and
    // the checked, focused radio still shows the inset focus ring.
    const paint = await radios.nth(0).evaluate((el) => {
      const group = el.closest(".ui-segmented");
      return {
        groupBg: group ? getComputedStyle(group).backgroundColor : "",
        ring: getComputedStyle(el).boxShadow,
      };
    });
    expect(paint.groupBg).toBe("rgba(0, 0, 0, 0)");
    expect(paint.ring).toContain("inset");

    const layers = menu.getByRole("menuitemcheckbox");
    await expect(layers).toHaveCount(4);
    const controls = [
      ...(await menu.getByRole("menuitem").all()),
      ...(await radios.all()),
      ...(await layers.all()),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    await expectPageAxeClean(page, "#transport-overflow-menu");
  });
});
