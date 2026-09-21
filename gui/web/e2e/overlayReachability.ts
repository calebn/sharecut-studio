import { expect, type Locator, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";

/**
 * Shared reachability helpers for overlay viewport coverage.
 *
 * Overlays (transport Menu, Dialog consumers) must fit short viewports, scroll
 * their body region, and keep their lowest action/content target reachable —
 * with or without banner chrome (guest / follow) above the transport.
 */
export const SHORT_VIEWPORTS = [
  { width: 1280, height: 715 },
  { width: 390, height: 844 },
] as const;

export async function openHostProject(page: Page): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /aligned dialogue/i,
  );
}

export async function openTransportMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole("menu", { name: "Transport menu" });
  if (await menu.isVisible()) {
    return menu;
  }
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  if ((await menuButton.count()) === 0) {
    // The phone Listen mode intentionally hides transport chrome. Enter More,
    // where the compact transport and its project menu are available.
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await menuButton.click();
  return menu;
}

export async function expectOverflowYAuto(locator: Locator): Promise<void> {
  await expect
    .poll(async () => locator.evaluate((el) => getComputedStyle(el).overflowY))
    .toMatch(/^(auto|scroll)$/);
}

export async function expectFitsViewport(
  page: Page,
  overlay: Locator,
): Promise<void> {
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

export async function intersectsOverlay(
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

export async function expectVisibleInOverlay(
  overlay: Locator,
  target: Locator,
): Promise<void> {
  await expect(target).toBeVisible();
  // ShareDialog can add/remove room rows after the heading first renders. A
  // one-time scroll can therefore become stale while the dialog body reflows.
  // Re-scroll on every geometry poll, while retaining the explicit body-clip
  // assertion that `toBeVisible` does not provide.
  await expect
    .poll(async () => {
      try {
        await target.evaluate((el) => {
          el.scrollIntoView({ block: "nearest" });
        });
      } catch {
        return false;
      }
      return intersectsOverlay(overlay, target);
    })
    .toBe(true);
}

async function expectActionableWhenApplicable(target: Locator): Promise<void> {
  const actionable = await target.evaluate((el) =>
    el.matches("button, [role='button'], [role='menuitem'], a[href]"),
  );
  if (actionable) {
    await target.click({ trial: true });
  }
}

/**
 * The transport Menu's max-height is the remaining space under the trigger
 * (`--menu-available-height`), which shrinks when guest/follow banners stack
 * above the transport. Assert the panel fits, scrolls, stays above the phone
 * bottom nav when one is rendered, and keeps its last item reachable.
 */
export async function expectMenuLastItemReachable(page: Page): Promise<void> {
  const menu = await openTransportMenu(page);
  await expect(menu).toBeVisible();
  await expectOverflowYAuto(menu);
  await expectFitsViewport(page, menu);
  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  if (await primaryNav.isVisible().catch(() => false)) {
    const menuBox = await menu.boundingBox();
    const navBox = await primaryNav.boundingBox();
    if (menuBox && navBox) {
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(navBox.y + 2);
    }
  }
  const last = menu.getByRole("menuitem", {
    name: "Keyboard shortcuts (?)",
  });
  await expect(last).toBeVisible();
  const menuitemCount = await menu.getByRole("menuitem").count();
  for (let i = 1; i < menuitemCount; i += 1) {
    await page.keyboard.press("ArrowDown");
  }
  // The last item must be reachable through the menu's own scroller when the
  // menu overflows, or directly visible when it fits without scrolling.
  await expect
    .poll(async () =>
      menu.evaluate((el) => {
        const lastEl = [...el.querySelectorAll('[role="menuitem"]')].find((m) =>
          (m.textContent ?? "").includes("Keyboard shortcuts"),
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
  await last.click({ trial: true });
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

/**
 * Share's Record rooms section lives below the fold of the Dialog body
 * scroller. Assert the panel fits, only the shared body scrolls, and the rooms
 * target stays reachable.
 */
export async function expectShareRecordRoomsReachable(
  page: Page,
): Promise<void> {
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
  await expectVisibleInOverlay(body, rooms);
  const roomsTarget = dialog
    .getByRole("button", { name: "End room" })
    .or(dialog.getByText("No live record rooms."))
    .first();
  await expectVisibleInOverlay(body, roomsTarget);
  await expectActionableWhenApplicable(roomsTarget);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/**
 * Generic Dialog reachability for `.command-palette-body` consumers: the panel
 * fits the viewport, the body scrolls, and the lowest action/content target is
 * reachable through the scroller. The dialog is dismissed on success. The
 * target is asserted visible/reachable within the body scrollport. Actionable
 * targets receive a non-destructive Playwright trial click to catch overlays
 * that geometrically intersect but intercept pointer events.
 */
export async function expectDialogLowerTargetReachable(
  page: Page,
  dialogName: string,
  targetFor: (dialog: Locator) => Locator,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  const panel = dialog.locator(".command-palette-panel");
  const body = dialog.locator(".command-palette-body");
  await expectOverflowYAuto(body);
  await expectFitsViewport(page, panel);
  const target = targetFor(dialog);
  await expectVisibleInOverlay(body, target);
  await expectActionableWhenApplicable(target);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}
