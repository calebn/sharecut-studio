import { expect, test } from "@playwright/test";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * The editor menu hangs off the transport strip, which is a size container
 * and so its own stacking context. A Text panel control that is itself a
 * layer (the disabled Ignore button's opacity) must never draw over the open
 * menu, in Chromium or WebKit.
 */

test.use({ hasTouch: true, isMobile: true });

test("the open editor menu draws over the Text panel's Ignore button", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "Text" })
      .click();
    await page.getByRole("button", { name: /^Select/ }).click();
    const ignore = page.getByRole("button", { name: /^Ignore/ });
    await expect(ignore).toBeVisible();

    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();

    const box = await ignore.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    const overMenu = await page.evaluate(({ x, y }) => {
      const top = document.elementFromPoint(x, y);
      return top?.closest('[role="menu"]') !== null;
    }, point);
    const menuBox = await menu.boundingBox();
    const inside =
      menuBox !== null &&
      point.x >= menuBox.x &&
      point.x <= menuBox.x + menuBox.width &&
      point.y >= menuBox.y &&
      point.y <= menuBox.y + menuBox.height;
    expect(inside).toBe(true);
    expect(overMenu).toBe(true);
  });
});
