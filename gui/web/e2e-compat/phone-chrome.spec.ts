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
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await expect(redo).toHaveAccessibleDescription("Nothing to redo");
    for (const button of [undo, redo]) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    await undo.tap();
    await expect(page.locator(".lane-row")).toHaveCount(4);
    await expect(redo).toBeEnabled();
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
