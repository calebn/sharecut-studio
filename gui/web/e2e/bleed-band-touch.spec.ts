import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import { TOUCH_HIT_RADIUS_PX } from "../src/timeline/hitCandidates";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { type Point, touch, watchCommands } from "./touchTimeline";

const CLIENT_ID = "e2e-bleed-band-touch";
const HOLD_MS = LONG_PRESS_MS + 150;
const JOIN_S = 10;
const BAND = { fade_out_ms: 5, fade_in_ms: 5 };

const VIEWPORTS = [
  { name: "phone portrait", width: 390, height: 844, phone: true },
  { name: "phone landscape", width: 844, height: 390, phone: false },
] as const;

test.use({ hasTouch: true, isMobile: true });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-bleed-band-touch-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const left = project.timeline.clips[0];
  left.source_end = JOIN_S;
  left.off_speaker_mute_regions = [{ start_s: 4, end_s: JOIN_S, ...BAND }];
  project.timeline.clips.splice(1, 0, {
    ...left,
    id: "bleed-right",
    source_start: JOIN_S,
    source_end: 60,
    timeline_start: JOIN_S,
    fade_in_ms: 500,
    fade_out_ms: 500,
    off_speaker_mute_regions: [
      { start_s: JOIN_S, end_s: 16, ...BAND },
      { start_s: 54, end_s: 60, ...BAND },
    ],
  });
  fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  await switchE2eProject(projectPath);
});

test.afterEach(async ({ page }) => {
  await page.close();
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

const picks = (page: Page) =>
  page.locator('[data-hit-kind="bleed-attenuation"]');
const chooser = (page: Page) =>
  page.locator(".target-chooser:not(.is-closing)");
const createMenu = (page: Page) => page.locator(".create-menu");
const pin = (page: Page) =>
  page.locator('.comment-marker.pin[aria-label="Comment by Ada"]');

function centre(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function boxOf(
  locator: ReturnType<Page["locator"]>,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("target has no box");
  return box;
}

function distance(
  box: { x: number; y: number; width: number; height: number },
  at: Point,
): number {
  return Math.hypot(
    at.x - Math.min(Math.max(at.x, box.x), box.x + box.width),
    at.y - Math.min(Math.max(at.y, box.y), box.y + box.height),
  );
}

async function openBands(
  page: Page,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  await page.goto("/");
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "AddComment",
    { body: "Ada at the join", author: "Ada", timeline_start: JOIN_S },
    projectPath,
  );
  await rememberInspectorDetent(page, "half");
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport.phone) await openPhoneTimeline(page);
  await page.locator('[data-clip-id="bleed-right"]').first().click();
  await page
    .getByRole("button", { name: "Inspect automatic audio reduction" })
    .click();
  await expect(picks(page)).toHaveCount(2);
  await expect(pin(page)).toBeVisible();
}

async function refreshBands(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Refresh regions" }).click();
  await expect(picks(page)).toHaveCount(2);
  await expect.poll(() => pressedBands(page)).toEqual([false, false]);
}

async function chooserLabels(page: Page): Promise<string[]> {
  return page
    .getByRole("menuitemradio")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
}

async function settle(read: () => Promise<unknown>): Promise<void> {
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await read());
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

async function pressedBands(page: Page): Promise<boolean[]> {
  return picks(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-pressed") === "true"),
  );
}

async function liveHandlesInReach(page: Page, at: Point): Promise<string[]> {
  return page.evaluate(
    ({ x, y, radius }) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-hit-kind^="trim-"], [data-hit-kind^="fade-"]',
        ),
      ]
        .filter((el) => getComputedStyle(el).pointerEvents !== "none")
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            Math.hypot(
              x - Math.min(Math.max(x, r.left), r.right),
              y - Math.min(Math.max(y, r.top), r.bottom),
            ) <= radius
          );
        })
        .map((el) => el.getAttribute("data-hit-kind") ?? ""),
    { ...at, radius: TOUCH_HIT_RADIUS_PX },
  );
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: a held press at a band edge opens the chooser only where a second live target is in reach`, async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await openBands(page, viewport);
    const commands = watchCommands(page);
    const before = fs.readFileSync(projectPath, "utf8");
    const [joinBand, endBand] = [picks(page).nth(0), picks(page).nth(1)];
    const joinBox = await boxOf(joinBand);
    const endBox = await boxOf(endBand);
    expect(joinBox.x).toBeLessThan(endBox.x);
    const lowest = (box: typeof joinBox): Point => ({
      x: box.x + 3,
      y: box.y + box.height - 2,
    });

    const trimOut = page.locator(
      '[data-hit-kind="trim-out"][data-hit-id="bleed-right"]',
    );
    const atEnd: Point = {
      x: endBox.x + endBox.width - 3,
      y: endBox.y + endBox.height / 2,
    };
    const trimOutBox = await boxOf(trimOut);
    expect(distance(trimOutBox, atEnd)).toBeLessThanOrEqual(
      TOUCH_HIT_RADIUS_PX,
    );
    await expect(trimOut).toHaveCSS("pointer-events", "none");
    expect(await liveHandlesInReach(page, atEnd)).toEqual([]);
    await touch(cdp, "touchStart", [atEnd]);
    await page.waitForTimeout(HOLD_MS);
    await expect(chooser(page)).toHaveCount(0);
    await expect(createMenu(page)).toHaveCount(0);
    await touch(cdp, "touchEnd");
    await expect.poll(() => pressedBands(page)).toEqual([false, true]);
    await refreshBands(page);

    const atJoin = lowest(joinBox);
    expect(await liveHandlesInReach(page, atJoin)).toEqual([]);
    await touch(cdp, "touchStart", [atJoin]);
    await expect
      .poll(() => chooserLabels(page))
      .toEqual(["Roll at 00:10.000", "Automatic audio reduction at 00:10.000"]);
    await touch(cdp, "touchEnd");
    const band = page.getByRole("menuitemradio", {
      name: "Automatic audio reduction at 00:10.000",
    });
    await settle(() => band.boundingBox());
    await touch(cdp, "touchStart", [centre(await boxOf(band))]);
    await touch(cdp, "touchEnd");
    await expect(chooser(page)).toHaveCount(0);
    await expect.poll(() => pressedBands(page)).toEqual([true, false]);

    expect(commands.map((c) => c.type)).toEqual([]);
    expect(fs.readFileSync(projectPath, "utf8")).toBe(before);
  });

  test(`${viewport.name}: no finger point reaches both a band and a comment pin`, async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await openBands(page, viewport);
    const pinBox = await boxOf(pin(page));
    for (const band of [picks(page).nth(0), picks(page).nth(1)]) {
      const bandBox = await boxOf(band);
      const gap = Math.max(
        bandBox.y - (pinBox.y + pinBox.height),
        pinBox.y - (bandBox.y + bandBox.height),
      );
      expect(gap).toBeGreaterThan(TOUCH_HIT_RADIUS_PX);
    }

    const bandBox = await boxOf(picks(page).nth(0));
    const overBand = { x: bandBox.x + 3, y: bandBox.y + 1 };
    await touch(cdp, "touchStart", [overBand]);
    await page.waitForTimeout(HOLD_MS);
    await expect.poll(() => chooserLabels(page)).toHaveLength(2);
    expect(await chooserLabels(page)).toEqual([
      "Roll at 00:10.000",
      "Automatic audio reduction at 00:10.000",
    ]);
    await touch(cdp, "touchEnd");
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);

    await touch(cdp, "touchStart", [centre(pinBox)]);
    await expect
      .poll(() => chooserLabels(page))
      .toEqual(["Join at 00:10.000", "Comment by Ada at 00:10.000"]);
    await touch(cdp, "touchEnd");
    const comment = page.getByRole("menuitemradio", {
      name: "Comment by Ada at 00:10.000",
    });
    await settle(() => comment.boundingBox());
    await touch(cdp, "touchStart", [centre(await boxOf(comment))]);
    await touch(cdp, "touchEnd");
    await expect(chooser(page)).toHaveCount(0);
    await expect(pin(page)).toHaveClass(/selected/);
  });
}
