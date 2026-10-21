import { expect, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "../e2e/deepZoom";
import { postDocumentCommand } from "../e2e/documentCommand";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * #1077 phone chrome on Chromium and WebKit with touch emulation: a phone
 * held sideways (932x432, the timeline maximized) keeps three compact lanes in
 * view, the tool rail carries Undo and Redo on both shells, the editor page
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

/** Lanes wholly visible between the pinned ruler rows and the tool rail. */
async function visibleLanes(page: Page) {
  return page.evaluate(() => {
    const lanes = [...document.querySelectorAll(".lane-row")].map((lane) =>
      lane.getBoundingClientRect(),
    );
    const rail = document.querySelector(".editing-tool-rail");
    const scroller = document.querySelector(".timeline-scroll");
    if (!rail || !scroller || lanes.length === 0) return null;
    const bottom = Math.min(
      rail.getBoundingClientRect().top,
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
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    await addTracks(page, projectPath, 3);
    await expect(page.locator(".lane-row")).toHaveCount(5);
    await page.getByRole("button", { name: "Maximize timeline" }).tap();

    await expect.poll(() => visibleLanes(page)).toMatchObject({ height: 72 });
    expect((await visibleLanes(page))!.full).toBeGreaterThanOrEqual(3);

    const rail = page.getByRole("group", { name: "Undo and redo" });
    const undo = rail.getByRole("button", { name: "Undo" });
    const redo = rail.getByRole("button", { name: "Redo" });
    await expect(undo).not.toHaveAttribute("aria-disabled");
    await expect(redo).toHaveAttribute("aria-disabled", "true");
    await expect(redo).toHaveAccessibleDescription("Nothing to redo");
    for (const button of [undo, redo]) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // A finger gets the reason too, not only a hover title.
    await redo.tap({ force: true });
    await expect(
      page.getByRole("status").filter({ hasText: "Nothing to redo" }),
    ).toBeVisible();
    await expect(page.locator(".lane-row")).toHaveCount(5);

    await undo.tap();
    await expect(page.locator(".lane-row")).toHaveCount(4);
    await expect(redo).not.toHaveAttribute("aria-disabled");
  });
});

test("a phone in portrait keeps Undo and Redo on the tool row and five lanes", async ({
  page,
}) => {
  await page.setViewportSize(PORTRAIT_SAFARI);
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await addTracks(page, projectPath, 4);
    await openPhoneTimeline(page);
    await expect(page.locator(".lane-row")).toHaveCount(6);

    const rail = page.getByRole("group", { name: "Editing tools" });
    const undo = rail.getByRole("button", { name: "Undo" });
    const redo = rail.getByRole("button", { name: "Redo" });
    const [railBox, undoBox, redoBox, rangeBox] = await Promise.all([
      rail.boundingBox(),
      undo.boundingBox(),
      redo.boundingBox(),
      rail.getByRole("button", { name: "Select range" }).boundingBox(),
    ]);
    // One row: the pair sits level with the tools, 44px squares, inside the rail.
    expect(Math.abs(undoBox!.y - rangeBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(redoBox!.y - undoBox!.y)).toBeLessThanOrEqual(1);
    expect(undoBox!.width).toBeGreaterThanOrEqual(44);
    expect(redoBox!.x + redoBox!.width).toBeLessThanOrEqual(
      railBox!.x + railBox!.width,
    );
    // The Select/Blade track grows with its 44px buttons instead of leaving
    // them hanging below it (impeccable pass on the rebased phone shell).
    const track = rail.locator(".tool-mode-toggle");
    const trackBox = (await track.boundingBox())!;
    for (const tool of await track.getByRole("button").all()) {
      const box = (await tool.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(trackBox.y - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(
        trackBox.y + trackBox.height + 0.5,
      );
    }
    // The ingest buttons give way on a rail this narrow; Menu and More keep them.
    await expect(rail.getByRole("button", { name: "Import" })).toBeHidden();

    expect((await visibleLanes(page))!.full).toBeGreaterThanOrEqual(5);
  });
});

test("a 360px phone keeps Zoom, Undo and Redo on the tool row, and Zoom runs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await openPhoneTimeline(page);

    const rail = page.getByRole("group", { name: "Editing tools" });
    const names = [
      "Select tool",
      "Blade tool",
      "Select range",
      "Zoom out",
      "Zoom in",
      "Undo",
      "Redo",
    ];
    const boxes = await Promise.all(
      names.map((name) =>
        rail.getByRole("button", { name, exact: true }).boundingBox(),
      ),
    );
    const railBox = (await rail.boundingBox())!;
    for (const box of boxes) {
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        railBox.x + railBox.width,
      );
    }

    const zoomIn = rail.getByRole("button", { name: "Zoom in" });
    const before = await rulerWidthPx(page);
    await zoomIn.tap();
    await expect.poll(() => rulerWidthPx(page)).toBeGreaterThan(before);
    const zoomed = await rulerWidthPx(page);
    await rail.getByRole("button", { name: "Zoom out" }).tap();
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
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell")).toBeVisible();
    await suggestPendingEdits(page, projectPath);
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" })
      .click();
    await page
      .getByRole("button", { name: /impact/i })
      .first()
      .click();

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
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await openPhoneTimeline(page);
    const rail = page.getByRole("group", { name: "Undo and redo" });
    await expect(rail.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Redo" })).toBeVisible();

    const scroll = await page.evaluate(() => {
      const shell = document.querySelector(".daw-shell")!;
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
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
    await expect(hint).toBeHidden();
  });
});

async function expectLandscapeRail(page: Page, width: number) {
  await page.setViewportSize({ width, height: 834 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    const rail = page.getByRole("group", { name: "Editing tools" });
    for (const name of [
      "Select tool",
      "Blade tool",
      "Select range",
      "+ Track",
      "Import",
    ]) {
      await expect(
        rail.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    }
  });
}

test("an iPad Air 1180 wide in landscape keeps Select, Blade, Select range, + Track and Import on the rail", async ({
  page,
}) => {
  await expectLandscapeRail(page, 1180);
});

test("an iPad Pro 11 1194 wide in landscape keeps Select, Blade, Select range, + Track and Import on the rail (#1674)", async ({
  page,
}) => {
  await expectLandscapeRail(page, 1194);
});
