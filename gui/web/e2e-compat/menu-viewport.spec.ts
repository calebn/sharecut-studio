import { devices, expect, type Page, test } from "@playwright/test";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * #1372: a Menu opened from a phone track sheet stays inside the visual
 * viewport. The panel used to hang right-aligned off a trigger at the sheet's
 * left edge, so it opened at x = -125.8 and nothing in it could be tapped.
 * Menu panels are top-layer popovers, which ignore z-index, so a visible app
 * toast must still end up above an open menu whichever of the two came first.
 */

const phone = devices["iPhone 15 Pro"];

test.use({
  viewport: phone.viewport,
  userAgent: phone.userAgent,
  deviceScaleFactor: phone.deviceScaleFactor,
  isMobile: phone.isMobile,
  hasTouch: phone.hasTouch,
  reducedMotion: "reduce",
});

function viewportBox(page: Page) {
  return page.evaluate(() => {
    const vv = window.visualViewport;
    return {
      left: vv?.offsetLeft ?? 0,
      top: vv?.offsetTop ?? 0,
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
    };
  });
}

async function checkTrackActions(
  page: Page,
  width: number,
  detent: "half" | "full",
) {
  await page.setViewportSize({ width, height: 852 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await openPhoneTimeline(page);
    await page.locator(".track-header-open").first().tap();
    const sheet = page.getByRole("dialog", { name: "Inspector" });
    await expect(sheet).toBeVisible();
    if (detent === "full") {
      await sheet.getByRole("button", { name: "Expand", exact: true }).tap();
      await expect(
        sheet.getByRole("button", { name: "Collapse", exact: true }),
      ).toBeVisible();
    }

    await sheet.getByRole("button", { name: "Track actions" }).tap();
    const menu = page.getByRole("menu", { name: "Track actions" });
    await expect(menu).toBeVisible();

    const box = await menu.boundingBox();
    const viewport = await viewportBox(page);
    const where = `${width} wide, ${detent} detent`;
    expect(box, where).not.toBeNull();
    expect(box!.x, where).toBeGreaterThanOrEqual(viewport.left);
    expect(box!.y, where).toBeGreaterThanOrEqual(viewport.top);
    expect(box!.x + box!.width, where).toBeLessThanOrEqual(
      viewport.left + viewport.width,
    );
    expect(box!.y + box!.height, where).toBeLessThanOrEqual(
      viewport.top + viewport.height,
    );

    const first = menu.getByRole("menuitem").first();
    await expect(first).toHaveAccessibleName("Smooth all joins");
    const itemBox = await first.boundingBox();
    const topmost = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest('[role="menuitem"]')?.textContent ?? null;
      },
      {
        x: itemBox!.x + itemBox!.width / 2,
        y: itemBox!.y + itemBox!.height / 2,
      },
    );
    expect(topmost, where).toBe("Smooth all joins");

    const applied = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        (request.postData() ?? "").includes("ApplyFadeRecommendations"),
    );
    await first.tap();
    await applied;
    await expect(menu).toHaveCount(0);
  });
}

test("Track actions opens inside a 390 and a 393 wide phone viewport in both detents and its first item works", async ({
  page,
}) => {
  for (const width of [390, 393]) {
    for (const detent of ["half", "full"] as const) {
      await checkTrackActions(page, width, detent);
    }
  }
});

async function expectToastUndoTopmost(page: Page, where: string) {
  const undo = page
    .locator(".ui-toast-region--app")
    .getByRole("button", { name: "Undo", exact: true });
  await expect(undo, where).toBeVisible();
  const box = await undo.boundingBox();
  const hit = await page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        inToast: el?.closest(".ui-toast-region--app") != null,
        label: el?.textContent ?? null,
      };
    },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  expect(hit, where).toEqual({ inToast: true, label: "Undo" });
}

async function reorderFirstTrack(page: Page, projectPath: string) {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await openPhoneTimeline(page);
  await page.locator(".track-header-open").first().tap();
  const sheet = page.getByRole("dialog", { name: "Inspector" });
  await sheet.getByRole("button", { name: "Move track down" }).tap();
}

const toastCard = (page: Page) =>
  page.locator(".ui-toast-region--app .ui-toast");
const transportMenu = (page: Page) =>
  page.getByRole("menu", { name: "Transport menu" });

test("an app toast stays topmost and tappable over a transport menu opened after it", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await reorderFirstTrack(page, projectPath);
    await expect(toastCard(page)).toContainText("Reordered track");

    await page.getByRole("button", { name: "Menu", exact: true }).tap();
    await expect(transportMenu(page)).toBeVisible();
    await expectToastUndoTopmost(page, "toast first");
  });
});

test("an app toast stays topmost and tappable over a transport menu that was open before it", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await page.route("**/api/document/command*", async (route) => {
      if ((route.request().postData() ?? "").includes("ReorderTrack")) {
        await new Promise((done) => setTimeout(done, 1500));
      }
      await route.continue();
    });
    await reorderFirstTrack(page, projectPath);
    await page.getByRole("button", { name: "Menu", exact: true }).tap();
    await expect(transportMenu(page)).toBeVisible();
    await expect(toastCard(page)).toHaveCount(0);

    await expect(toastCard(page)).toContainText("Reordered track");
    await expect(transportMenu(page)).toBeVisible();
    await expectToastUndoTopmost(page, "menu first");
  });
});
