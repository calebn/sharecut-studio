import { expect, type Locator, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";

const VIEWPORTS = [
  { width: 1280, height: 715 },
  { width: 390, height: 844 },
] as const;

async function openHostProject(page: Page): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
}

async function openTransportMenu(page: Page): Promise<Locator> {
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menuButton.count()) === 0) {
    // The phone Listen mode intentionally hides transport chrome. Enter More,
    // where the compact transport and its project menu are available.
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await menuButton.click();
  return page.getByRole("menu", { name: "Transport menu" });
}

async function expectOverflowYAuto(locator: Locator): Promise<void> {
  await expect
    .poll(async () => locator.evaluate((el) => getComputedStyle(el).overflowY))
    .toMatch(/^(auto|scroll)$/);
}

async function expectFitsViewport(page: Page, overlay: Locator): Promise<void> {
  const vp = page.viewportSize();
  expect(vp).toBeTruthy();
  await expect
    .poll(async () => {
      const box = await overlay.boundingBox();
      if (!box || !vp) {
        return false;
      }
      return box.y >= -2 && box.y + box.height <= vp.height + 2;
    })
    .toBe(true);
}

async function intersectsOverlay(
  overlay: Locator,
  target: Locator,
): Promise<boolean> {
  const t = await target.boundingBox();
  const o = await overlay.boundingBox();
  if (!t || !o) {
    return false;
  }
  const visibleH =
    Math.min(t.y + t.height, o.y + o.height) - Math.max(t.y, o.y);
  const visibleW = Math.min(t.x + t.width, o.x + o.width) - Math.max(t.x, o.x);
  return visibleH >= 8 && visibleW >= 8;
}

async function expectVisibleInOverlay(
  overlay: Locator,
  target: Locator,
): Promise<void> {
  await expect(target).toBeVisible();
  await expect.poll(async () => intersectsOverlay(overlay, target)).toBe(true);
}

test.describe("overlay viewport scroll", () => {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    test(`Menu last item is reachable at ${label}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openHostProject(page);
      const menu = await openTransportMenu(page);
      await expect(menu).toBeVisible();
      await expectOverflowYAuto(menu);
      await expectFitsViewport(page, menu);
      const last = menu.getByRole("menuitem", {
        name: "Keyboard shortcuts (?)",
      });
      await expect(last).toBeVisible();
      const menuitemCount = await menu.getByRole("menuitem").count();
      for (let i = 1; i < menuitemCount; i += 1) {
        await page.keyboard.press("ArrowDown");
      }
      if (viewport.height <= 715) {
        await expect
          .poll(async () =>
            menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1),
          )
          .toBe(true);
      }
      await expect
        .poll(async () =>
          menu.evaluate((el) => {
            const lastEl = [...el.querySelectorAll('[role="menuitem"]')].find(
              (m) => (m.textContent ?? "").includes("Keyboard shortcuts"),
            );
            if (!lastEl) {
              return false;
            }
            lastEl.scrollIntoView({ block: "nearest" });
            const vr = el.getBoundingClientRect();
            const lr = lastEl.getBoundingClientRect();
            return (
              Math.min(lr.bottom, vr.bottom) - Math.max(lr.top, vr.top) >= 8 &&
              Math.min(lr.right, vr.right) - Math.max(lr.left, vr.left) >= 8
            );
          }),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    });

    test(`Share dialog Record rooms is reachable at ${label}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openHostProject(page);
      await openTransportMenu(page);
      await page.getByRole("menuitem", { name: "Share…" }).click();
      const dialog = page.getByRole("dialog", { name: "Share" });
      await expect(dialog).toBeVisible();
      const panel = dialog.locator(".command-palette-panel");
      const body = dialog.locator(".command-palette-body");
      await expectOverflowYAuto(body);
      await expect
        .poll(async () =>
          dialog
            .locator(".share-dialog-body")
            .evaluate((el) => getComputedStyle(el).overflowY),
        )
        .not.toMatch(/^(auto|scroll)$/);
      await expectFitsViewport(page, panel);
      const rooms = dialog.getByRole("heading", { name: "Record rooms" });
      await expect(rooms).toBeVisible();
      if (!(await intersectsOverlay(panel, rooms))) {
        await rooms.evaluate((el) => {
          el.scrollIntoView({ block: "nearest" });
        });
      }
      await expectVisibleInOverlay(panel, rooms);
      const roomsTarget = dialog
        .getByRole("button", { name: "End room" })
        .or(dialog.getByText("No live record rooms."));
      await expect(roomsTarget.first()).toBeVisible();
      if (!(await intersectsOverlay(panel, roomsTarget.first()))) {
        await roomsTarget.first().evaluate((el) => {
          el.scrollIntoView({ block: "nearest" });
        });
      }
      await expectVisibleInOverlay(panel, roomsTarget.first());
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  }
});
