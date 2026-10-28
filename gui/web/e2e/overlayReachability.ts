import { expect, type Locator, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  openProject,
  openProjectMenu,
  openProjectMenuItem,
  openShare,
} from "./stageNav";

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

export async function openHostProject(
  page: Page,
  heading: RegExp = /aligned dialogue/i,
  options: { timeout?: number } = {},
): Promise<void> {
  await openProject(page, e2eProjectPath);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    heading,
    options,
  );
}

export const openTransportMenu = openProjectMenu;

/** Open the transport Menu and choose `menuItem` (e.g. "Connect agent…"). */
export const openDialogFromMenu = openProjectMenuItem;

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
  // A dialog can add/remove rows after the heading first renders. A
  // one-time scroll can therefore become stale while the dialog body reflows.
  // Re-scroll on every geometry poll, while retaining the explicit body-clip
  // assertion that `toBeVisible` does not provide.
  await expect
    .poll(async () => {
      await target.evaluate((el) => {
        el.scrollIntoView({ block: "nearest" });
      });
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
 * The Project menu's max-height is the remaining space under the trigger
 * (`--menu-available-height`), which shrinks when guest/follow banners stack
 * above the stage. Assert the panel fits, scrolls, stays above the phone tab
 * bar when one is rendered, and keeps its last row reachable.
 */
export async function expectMenuLastItemReachable(
  page: Page,
  open: (page: Page) => Promise<Locator> = openProjectMenu,
): Promise<void> {
  const menu = await open(page);
  await expect(menu).toBeVisible();
  await expectOverflowYAuto(menu);
  await expectFitsViewport(page, menu);
  const tabBar = page.locator(".stage-frame-tabs");
  if (await tabBar.isVisible().catch(() => false)) {
    const menuBox = await menu.boundingBox();
    const tabBox = await tabBar.boundingBox();
    if (menuBox && tabBox) {
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(tabBox.y + 2);
    }
  }
  const rows = menu.locator('[role="menuitem"], [role="menuitemradio"]');
  const last = rows.last();
  await expect(last).toBeVisible();
  await last.scrollIntoViewIfNeeded();
  await expect
    .poll(async () =>
      menu.evaluate((el) => {
        const all = el.querySelectorAll(
          '[role="menuitem"], [role="menuitemradio"]',
        );
        const lastEl = all[all.length - 1];
        if (!lastEl) {
          return false;
        }
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
 * Share's Record rooms section lives below the fold of the Deliver page
 * scroller. Assert its heading and its lowest target scroll into view and the
 * target takes a click.
 */
export async function expectShareRecordRoomsReachable(
  page: Page,
): Promise<void> {
  const share = await openShare(page);
  const rooms = share.getByRole("heading", { name: "Record rooms" });
  await rooms.scrollIntoViewIfNeeded();
  await expect(rooms).toBeInViewport();
  const roomsTarget = share
    .getByRole("button", { name: "End room" })
    .or(share.getByText("No record rooms yet."))
    .first();
  await roomsTarget.scrollIntoViewIfNeeded();
  await expect(roomsTarget).toBeInViewport();
  await expectActionableWhenApplicable(roomsTarget);
}

/**
 * Generic Dialog reachability for `.command-palette-body` consumers: the panel
 * fits the viewport, the body scrolls, and the lowest action/content target is
 * reachable through the scroller, or sits in the pinned footer. The dialog is
 * dismissed on success. The
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
  const pinned = await target.evaluate(
    (el) => el.closest(".command-palette-footer") !== null,
  );
  const footer = dialog.locator(".command-palette-footer");
  await expectVisibleInOverlay(pinned ? footer : body, target);
  await expectActionableWhenApplicable(target);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/**
 * Dialog presentation contract: on phone and tablet shells a Dialog is a
 * bottom sheet (flush to the bottom edge, edge to edge on phone width) and
 * its pinned footer is visible; elsewhere it is a centered card.
 */
export async function expectDialogPresentation(
  page: Page,
  dialogName: string,
  expected: { sheet: boolean; fullWidth: boolean },
): Promise<{ dialog: Locator; panel: Locator; footer: Locator }> {
  const dialog = page.getByRole("dialog", { name: dialogName, exact: true });
  await expect(dialog).toBeVisible();
  const panel = dialog.locator(".command-palette-panel");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("expectDialogPresentation needs a viewport");
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      if (!box) return null;
      return {
        atBottom: Math.abs(box.y + box.height - viewport.height) <= 2,
        fullWidth: box.width >= viewport.width - 2,
      };
    })
    .toMatchObject(
      expected.sheet
        ? { atBottom: true, fullWidth: expected.fullWidth }
        : { atBottom: false },
    );
  const footer = panel.locator(".command-palette-footer");
  await expect(footer).toBeVisible();
  return { dialog, panel, footer };
}
