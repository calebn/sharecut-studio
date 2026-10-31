import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "./axe";
import { layer } from "./lifecycleAudit";
import { openHostProject } from "./overlayReachability";

/*
 * Pointer parity (#1793): a right click on a clip or lane opens the same create menu a long press
 * on empty space opens on touch, and the Menu key or Shift+F10 on the focused target does too.
 */

const menu = (page: Page) => page.getByRole("menu", { name: /^Create at / });

async function playheadSec(page: Page): Promise<number> {
  const now = await page
    .getByRole("slider", { name: "Timeline position" })
    .first()
    .getAttribute("aria-valuenow");
  return Number(now);
}

async function volumeLayerOn(page: Page): Promise<boolean> {
  await page.getByRole("button", { name: "View options" }).click();
  const sheet = page.getByRole("dialog", { name: "View" });
  const on = await sheet
    .getByRole("checkbox", { name: "Volume envelope", exact: true })
    .isChecked();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  return on;
}

test("right click on a lane opens the create menu at that time, with no a11y violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const lane = page.locator(".lane-row").first();
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2, {
    button: "right",
  });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem").first()).toBeVisible();
  await expect(page.locator(".edit-create-menu")).toHaveCount(1);
  const axe = await new AxeBuilder({ page })
    .disableRules([...STUDIO_AXE_DISABLED_RULES])
    .include(".edit-create-menu")
    .analyze();
  expect(axe.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("right click on a clip opens the create menu too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await page.locator(".clip-block").first().click({ button: "right" });
  await expect(menu(page)).toBeVisible();
});

test("a menu item runs its command and closes the menu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await page.locator(".clip-block").first().click({ button: "right" });
  const items = menu(page).getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  await menu(page)
    .getByRole("menuitem", { name: /Add chapter here/ })
    .click();
  await expect(menu(page)).toHaveCount(0);
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(1);
  // Leave the shared project as found: later specs measure its markers.
  await page.keyboard.press("Control+z");
  await expect(
    page.locator('.sys-marker[data-kind="chapter"] .sys-marker-hit'),
  ).toHaveCount(0);
});

test("Shift+F10 on a focused envelope level opens the create menu and Escape closes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  await layer(page, "Volume envelope", true);
  const level = page.getByRole("slider", { name: "Envelope level" }).first();
  await level.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("Shift+F10 with no target focused opens the create menu at the playhead on the selected track (#1877)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const lane = page.locator(".lane-row[data-track-id]").first();
  await lane.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  const label = await menu(page).getAttribute("aria-label");
  expect(label).toMatch(/^Create at 01:00\.000/);
  // A bare F10 is not the menu's key.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("F10");
  await expect(menu(page)).toHaveCount(0);
});

test("Escape returns focus to the clip the menu was opened on, and Tab out closes the menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const clip = page.locator(".clip-block").first();
  const hit = clip.locator(".clip-hit");
  await clip.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(hit).toBeFocused();

  await clip.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu(page)).toHaveCount(0);
});

test("a mouse press outside the menu closes it and does not move the playhead", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const lane = page.locator(".lane-row").first();
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2, {
    button: "right",
  });
  await expect(menu(page)).toBeVisible();
  const before = await playheadSec(page);
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height - 6);
  await expect(menu(page)).toHaveCount(0);
  expect(await playheadSec(page)).toBe(before);
});

test("Add volume point shows a hidden envelope, and one undo removes the point and leaves the envelope showing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHostProject(page);
  const points = page.locator('[data-hit-kind="envelope-point"]');
  await layer(page, "Volume envelope", true);
  const before = await points.count();
  await layer(page, "Volume envelope", false);
  await expect(points).toHaveCount(0);
  expect(await volumeLayerOn(page)).toBe(false);

  const lane = page.locator(".lane-row").first();
  const box = await lane.boundingBox();
  if (!box) throw new Error("no lane");
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2, {
    button: "right",
  });
  await menu(page).getByRole("menuitem", { name: "Add volume point" }).click();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => points.count()).toBeGreaterThan(before);

  await page.keyboard.press("Control+z");
  await expect.poll(() => points.count()).toBe(before);
  expect(await volumeLayerOn(page)).toBe(true);
});
