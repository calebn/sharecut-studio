import { expect, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * #1077 phone chrome on Chromium and WebKit with touch emulation: a phone
 * held sideways (932x432, the timeline maximized) keeps three compact lanes in
 * view, the tool rail carries Undo and Redo on both shells, and the editor
 * page scrolls a runway under the fixed shell so Safari can collapse its bars
 * without moving the shell.
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
    // The ingest buttons give way on a rail this narrow; Menu and More keep them.
    await expect(rail.getByRole("button", { name: "Import" })).toBeHidden();

    expect((await visibleLanes(page))!.full).toBeGreaterThanOrEqual(5);
  });
});

test("the phone timeline shows Undo and Redo and lets Safari hide its bars", async ({
  page,
}) => {
  await page.setViewportSize(PORTRAIT);
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
      const result = {
        scrollY: Math.round(window.scrollY),
        shellTop: Math.round(shell.getBoundingClientRect().top),
        shellBottom: Math.round(shell.getBoundingClientRect().bottom),
      };
      window.scrollTo(0, 0);
      return result;
    });
    // A runway of a quarter screen scrolls; the fixed shell does not move.
    expect(scroll.scrollY).toBeGreaterThan(100);
    expect(scroll.shellTop).toBe(0);
    expect(scroll.shellBottom).toBe(PORTRAIT.height);
  });
});
