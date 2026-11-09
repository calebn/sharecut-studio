import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { openProject } from "../e2e/stageNav";

const original = (page: Page) => page.locator(".sys-player-a").first();

async function holdA(page: Page) {
  await expect(original(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.down("a");
  await expect(original(page)).toHaveAttribute("aria-pressed", "true");
}

test.beforeEach(async ({ page }) => {
  await openProject(page, e2eProjectPath);
  await expect(original(page)).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } });
});

test("holding A with nothing selected plays the original and restores on keyup", async ({
  page,
}) => {
  await holdA(page);
  await page.keyboard.press("Shift");
  await expect(original(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("a");
  await expect(original(page)).toHaveAttribute("aria-pressed", "false");
});

test("A restores the original when the window loses focus", async ({
  page,
}) => {
  await holdA(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(original(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.up("a");
  await expect(original(page)).toHaveAttribute("aria-pressed", "false");
});

test("A restores the original when the tab is hidden", async ({ page }) => {
  await holdA(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(original(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.up("a");
});
