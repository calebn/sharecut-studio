import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test("open transport menu has valid accessible children", async ({ page }) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Transport menu" });
  await expect(menu.getByRole("menuitemcheckbox")).toHaveCount(4);
  await expectPageAxeClean(page, "#transport-overflow-menu");
});
