import { expect, type Locator, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "../e2e/deepZoom";
import { postDocumentCommand } from "../e2e/documentCommand";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openPanel, openProject, projectMenuButton } from "../e2e/stageNav";

/*
 * #1077 phone chrome on Chromium and WebKit with touch emulation: a phone
 * held sideways (932x432) keeps three compact lanes in view, the App header
 * carries Undo and Redo on both shells, the editor page
 * never scrolls under the fixed shell, and a Safari tab offers Add to Home
 * Screen (the phone's full-screen path) once per browser.
 */

test.use({ hasTouch: true, isMobile: true });

const LANDSCAPE = { width: 932, height: 432 };
const PORTRAIT = { width: 432, height: 932 };
const PORTRAIT_SAFARI = { width: 440, height: 763 };

async function addTracks(page: Page, projectPath: string, count: number) {
  for (let i = 0; i < count; i++)
    await postDocumentCommand(
      page,
      "e2e-phone-chrome",
      "AddTrack",
      { label: `Extra voice ${i + 1}` },
      projectPath,
    );
}

/** Lanes wholly visible between the pinned ruler rows and the Player. */
async function visibleLanes(page: Page) {
  return page.evaluate(() => {
    const lanes = [...document.querySelectorAll(".lane-row")].map((lane) =>
      lane.getBoundingClientRect(),
    );
    const chrome = document.querySelector(".stage-frame-player");
    const scroller = document.querySelector(".timeline-scroll");
    if (!chrome || !scroller || lanes.length === 0) return null;
    const bottom = Math.min(
      chrome.getBoundingClientRect().top,
      scroller.getBoundingClientRect().bottom,
    );
    const top = Math.min(...lanes.map((r) => r.top));
    return {
      height: Math.round(lanes[0]!.height),
      full: lanes.filter((r) => r.top >= top - 0.5 && r.bottom <= bottom + 0.5)
        .length,
      total: lanes.length,
    };
  });
}

test("a phone held sideways keeps three compact lanes and Undo in reach", async ({
  page,
}) => {
  await page.setViewportSize(LANDSCAPE);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await addTracks(page, projectPath, 3);
    await expect(page.locator(".lane-row")).toHaveCount(5);
    await expect.poll(() => visibleLanes(page)).toMatchObject({ height: 72 });
    expect((await visibleLanes(page))!.full).toBeGreaterThanOrEqual(3);

    const header = page.locator(".sys-app-header-host");
    const undo = header.getByRole("button", { name: "Undo", exact: true });
    const redo = header.getByRole("button", { name: "Redo", exact: true });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    for (const button of [undo, redo]) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator(".lane-row")).toHaveCount(5);

    await undo.tap();
    await expect(page.locator(".lane-row")).toHaveCount(4);
    await expect(redo).toBeEnabled();
  });
});

test("a phone in portrait keeps Undo and Redo in the header, the corner controls on one row and four whole lanes", async ({
  page,
}) => {
  await page.setViewportSize(PORTRAIT_SAFARI);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await addTracks(page, projectPath, 4);
    await openPhoneTimeline(page);
    await expect(page.locator(".lane-row")).toHaveCount(6);

    const rail = page.getByRole("group", { name: "Timeline view" });
    const header = page.locator(".sys-app-header-host");
    const railBox = (await rail.boundingBox())!;
    const buttons = ["Select range", "Zoom out", "Zoom in"].map((name) =>
      rail.getByRole("button", { name, exact: true }),
    );
    // One row: the controls sit level, 44px squares, inside the corner.
    const toolBoxes = await Promise.all(buttons.map((b) => b.boundingBox()));
    for (const box of toolBoxes) {
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(box!.y - toolBoxes[0]!.y)).toBeLessThanOrEqual(1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        railBox.x + railBox.width + 0.5,
      );
    }
    for (const name of ["Undo", "Redo"]) {
      const box = (await header
        .getByRole("button", { name, exact: true })
        .boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width).toBeLessThanOrEqual(PORTRAIT_SAFARI.width);
    }

    // The frame's header, corner, Player and tab bar leave room for four 104 px
    // lanes on this phone.
    expect((await visibleLanes(page))!.full).toBeGreaterThanOrEqual(4);
  });
});

test("a 360px phone keeps the range toggle, Zoom, Undo and Redo whole and in reach, and Zoom runs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await openPhoneTimeline(page);

    const groups: [Locator, string[]][] = [
      [
        page.getByRole("group", { name: "Timeline view" }),
        ["Select range", "Zoom out", "Zoom in"],
      ],
      [page.locator(".sys-app-header-host"), ["Undo", "Redo"]],
    ];
    for (const [group, names] of groups) {
      const groupBox = (await group.boundingBox())!;
      const boxes = await Promise.all(
        names.map((name) =>
          group.getByRole("button", { name, exact: true }).boundingBox(),
        ),
      );
      for (const box of boxes) {
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          groupBox.x + groupBox.width + 0.5,
        );
      }
    }

    const view = page.getByRole("group", { name: "Timeline view" });
    const zoomIn = view.getByRole("button", { name: "Zoom in", exact: true });
    const before = await rulerWidthPx(page);
    await zoomIn.tap();
    await expect.poll(() => rulerWidthPx(page)).toBeGreaterThan(before);
    const zoomed = await rulerWidthPx(page);
    await view.getByRole("button", { name: "Zoom out", exact: true }).tap();
    await expect.poll(() => rulerWidthPx(page)).toBeLessThan(zoomed);
  });
});

async function suggestPendingEdits(page: Page, projectPath: string) {
  const trackId = await page.evaluate(async (path) => {
    const res = await fetch(
      `/api/project?path=${encodeURIComponent(path)}&phase=shell`,
    );
    const body = (await res.json()) as {
      tracks: { id: string; role?: string }[];
    };
    return body.tracks.find((track) => track.role === "dialogue")?.id;
  }, projectPath);
  for (const [start, end] of [
    [4, 6],
    [8, 9],
    [12, 13],
  ])
    await postDocumentCommand(
      page,
      "e2e-phone-chrome",
      "SuggestPendingEdit",
      { track_id: trackId, start, end, reason: "guest:suggest" },
      projectPath,
    );
}

test("Reject all asks with the count, then one Undo brings the pending edits back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame")).toBeVisible();
    await suggestPendingEdits(page, projectPath);
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame")).toBeVisible();
    await openPanel(page, "impact");

    const pending = page.locator(".impact-pending-select");
    await expect(pending).toHaveCount(3);
    const reject = page.getByRole("button", { name: "Reject all (3)" });
    expect((await reject.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await reject.tap();
    const dialog = page.getByRole("dialog", {
      name: "Reject 3 pending edits?",
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep reviewing" }).tap();
    await expect(dialog).toBeHidden();
    await expect(pending).toHaveCount(3);

    await reject.tap();
    await dialog.getByRole("button", { name: "Reject 3", exact: true }).tap();
    const toast = page.locator(".ui-toast-region--app");
    await expect(toast.getByText("Rejected 3 pending edits")).toBeVisible();
    await expect(pending).toHaveCount(0);
    await toast.getByRole("button", { name: /undo/i }).tap();
    await expect(pending).toHaveCount(3);
  });
});

test("the phone timeline shows Undo and Redo; a Safari tab offers the Home Screen once", async ({
  page,
}) => {
  await page.setViewportSize(PORTRAIT);
  // An iPhone Safari tab: iOS reports `standalone` false until launched from
  // the Home Screen, and touch points (desktop WebKit reports none).
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({
      standalone: false,
      maxTouchPoints: 5,
    }))
      Object.defineProperty(navigator, key, { value, configurable: true });
  });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await openPhoneTimeline(page);
    const header = page.locator(".sys-app-header-host");
    await expect(
      header.getByRole("button", { name: "Undo", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("button", { name: "Redo", exact: true }),
    ).toBeVisible();

    const scroll = await page.evaluate(() => {
      const shell = document.querySelector(".stage-frame")!;
      window.scrollTo(0, 100_000);
      return {
        scrollY: Math.round(window.scrollY),
        shellTop: Math.round(shell.getBoundingClientRect().top),
        shellBottom: Math.round(shell.getBoundingClientRect().bottom),
      };
    });
    expect(scroll).toEqual({
      scrollY: 0,
      shellTop: 0,
      shellBottom: PORTRAIT.height,
    });

    const hint = page.getByRole("complementary", { name: "Full screen" });
    await expect(
      hint.getByText(
        "In Safari's Share menu, choose Add to Home Screen to open ShareCut full screen.",
        { exact: true },
      ),
    ).toBeVisible();
    await hint.getByRole("button", { name: "Dismiss" }).click();
    await expect(hint).toBeHidden();
    await page.reload();
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(projectMenuButton(page)).toBeVisible();
    await expect(hint).toBeHidden();
  });
});

async function expectLandscapeCorner(page: Page, width: number) {
  await page.setViewportSize({ width, height: 834 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    const corner = page.getByRole("group", { name: "Timeline view" });
    for (const name of ["Select range", "Zoom in"]) {
      await expect(
        corner.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "+", exact: true }),
    ).toBeVisible();
  });
}

test("an iPad Air 1180 wide in landscape keeps Select range in the corner and the add-track button", async ({
  page,
}) => {
  await expectLandscapeCorner(page, 1180);
});

test("an iPad Pro 11 1194 wide in landscape keeps Select range in the corner and the add-track button (#1674)", async ({
  page,
}) => {
  await expectLandscapeCorner(page, 1194);
});
