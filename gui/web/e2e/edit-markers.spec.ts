import { expect, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import { setTheme, type Theme, withAppearance } from "./theme";
import { lane, projectJson, shot, TRACK, touch } from "./touchTimeline";

const CLIENT_ID = "e2e-edit-markers";
const GUEST = "guest";
const SPLITS = [10, 11, 12, 40, 50];
const DENSE_SPLITS = [
  ...Array.from({ length: 18 }, (_, i) => Number((10 + i * 0.1).toFixed(1))),
  ...Array.from({ length: 12 }, (_, i) => Number((20 + i * 3.3).toFixed(1))),
];
const MARKS = `${lane} [data-hit-kind="join"], ${lane} [data-hit-kind="edit-chip"]`;
const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  phoneLandscape: { width: 844, height: 390 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 180_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async ({ page }) => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-edit-markers-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function split(
  page: Page,
  at_times: readonly number[],
  track = TRACK,
): Promise<void> {
  for (const at_time of at_times) {
    await postDocumentCommand(
      page,
      CLIENT_ID,
      "SplitAtTime",
      { at_time, track_ids: [track] },
      projectPath,
    );
  }
}

const MODES: Record<number, "cut" | "fade" | "crossfade"> = {
  10: "cut",
  11: "crossfade",
  12: "fade",
  40: "crossfade",
  50: "cut",
};

/** Five joins, three of them close: one of each mode among them. */
async function fiveJoins(page: Page): Promise<void> {
  await split(page, SPLITS);
  const clips = (await projectJson(page, projectPath)).clips.tracks[TRACK];
  for (const [sec, mode] of Object.entries(MODES)) {
    const i = clips.findIndex((c) => c.timeline_start === Number(sec));
    await postDocumentCommand(
      page,
      CLIENT_ID,
      "SetClipJoin",
      {
        left_clip_id: clips[i - 1].id,
        right_clip_id: clips[i].id,
        mode,
        ...(mode === "crossfade" ? { length_ms: 200 } : {}),
      },
      projectPath,
    );
  }
}

/** The fixture at fit zoom, as a user opens it. */
async function openFit(
  page: Page,
  viewport: ViewportName,
  theme: Theme,
): Promise<void> {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (viewport === "phone") await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page
    .locator(".time-ruler")
    .first()
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("\\");
  await page.keyboard.press("Escape");
  await expect(page.locator(`${lane} .edit-chip`).first()).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };

async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
  }, selector);
}

async function centers(page: Page): Promise<number[]> {
  const found = await boxes(page, MARKS);
  return found.map((b) => b.x + b.width / 2).sort((a, b) => a - b);
}

async function playheadSec(page: Page): Promise<number> {
  const now = await page
    .locator(".time-ruler")
    .first()
    .getAttribute("aria-valuenow");
  return Number(now);
}

for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
  for (const theme of ["light", "dark"] as const) {
    test(`at fit zoom the three close joins fold into one chip, the rest stay glyphs, at ${viewport} in the ${theme} theme`, async ({
      page,
    }, info) => {
      await fiveJoins(page);
      await openFit(page, viewport, theme);
      const chip = page.locator(`${lane} .edit-chip`);
      await expect(chip).toHaveCount(1);
      await expect(chip).toHaveText("3");
      await expect(chip).toHaveAttribute(
        "aria-label",
        /^3 edits: .+\. Zoom in$/,
      );
      await expect(page.locator(`${lane} .edit-mark`)).toHaveCount(2);
      const xs = await centers(page);
      expect(xs).toHaveLength(3);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(23.5);
      }
      await shot(info, page, `edit-markers-${viewport}-${theme}`);
    });
  }
}

test("a mark draws a 12 px glyph and a chip no taller, and both sit at the lane's top", async ({
  page,
}) => {
  await fiveJoins(page);
  await openFit(page, "phone", "dark");
  const [laneBox] = await boxes(page, lane);
  const [glyph] = await boxes(page, `${lane} .edit-mark`);
  const [shape] = await boxes(page, `${lane} .edit-mark svg`);
  const [chip] = await boxes(page, `${lane} .edit-chip`);
  expect(shape.width).toBeCloseTo(12, 1);
  expect(shape.height).toBeCloseTo(12, 1);
  expect(glyph.height).toBeCloseTo(14, 1);
  expect(chip.height).toBeCloseTo(14, 1);
  expect(chip.width).toBeLessThanOrEqual(22);
  expect(glyph.y).toBeCloseTo(laneBox.y, 0);
  expect(chip.y).toBeCloseTo(laneBox.y, 0);
});

test.describe("dense", () => {
  const cells = withAppearance(
    ["phone", "phone", "phoneLandscape", "phoneLandscape", "tablet", "desktop"],
    0,
  ) as { cell: ViewportName; theme: Theme }[];
  for (const { cell: viewport, theme } of cells) {
    test(`thirty joins at fit zoom fold into chips that never touch, at ${viewport} in the ${theme} theme`, async ({
      page,
    }, info) => {
      await split(page, DENSE_SPLITS);
      await openFit(page, viewport, theme);
      const chips = await boxes(page, `${lane} .edit-chip`);
      const glyphs = await boxes(page, `${lane} .edit-mark`);
      const counts = await page.locator(`${lane} .edit-chip`).allTextContents();
      const total =
        glyphs.length + counts.reduce((n, text) => n + Number(text), 0);
      expect(total).toBe(30);
      expect(chips.length).toBeGreaterThan(0);
      for (const chip of chips) expect(chip.width).toBeLessThanOrEqual(22);
      const xs = await centers(page);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(23.5);
      }
      await shot(info, page, `edit-markers-dense-${viewport}-${theme}`);
    });
  }
});

test("a tap on the chip zooms in and splits it into its joins", async ({
  page,
}) => {
  await fiveJoins(page);
  await openFit(page, "phone", "dark");
  const before = await rulerWidthPx(page);
  const chip = page.locator(`${lane} .edit-chip`);
  const box = await chip.boundingBox();
  if (!box) throw new Error("chip has no box");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(`${lane} .edit-chip`)).toHaveCount(0);
  await expect(page.locator(`${lane} .edit-mark`)).toHaveCount(5);
  expect(await rulerWidthPx(page)).toBeGreaterThan(before);
});

test.describe("coarse pointer", () => {
  test.use({ isMobile: true });

  const joinDialog = (page: Page) =>
    page.getByRole("dialog", { name: /join at/ });

  async function open(page: Page): Promise<void> {
    await fiveJoins(page);
    await split(page, [30], GUEST);
    await openFit(page, "phone", "dark");
  }

  async function glyphAt(page: Page, index: number): Promise<Box> {
    return (await boxes(page, `${lane} .edit-mark`))[index];
  }

  test("a touch 20 px beside a glyph opens its join", async ({ page }) => {
    await open(page);
    const glyph = page.locator(`${lane} .edit-mark`).last();
    const box = await glyphAt(page, 1);
    await page.touchscreen.tap(box.x + box.width + 20, box.y + box.height / 2);
    await expect(glyph).toHaveAttribute("aria-expanded", "true");
    await expect(joinDialog(page)).toBeVisible();
  });

  test("a touch 30 px beside a glyph seeks", async ({ page }) => {
    await open(page);
    const box = await glyphAt(page, 0);
    await page.touchscreen.tap(box.x - 30, box.y + box.height / 2);
    await expect(joinDialog(page)).toHaveCount(0);
    expect(await playheadSec(page)).toBeGreaterThan(30);
    expect(await playheadSec(page)).toBeLessThan(40);
  });

  test("a touch in the lane's bottom gutter, under a chip, seeks", async ({
    page,
  }) => {
    await open(page);
    const [chip] = await boxes(page, `${lane} .edit-chip`);
    const [laneBox] = await boxes(page, lane);
    await page.touchscreen.tap(
      chip.x + chip.width / 2,
      laneBox.y + laneBox.height - 4,
    );
    await expect(joinDialog(page)).toHaveCount(0);
    expect(await playheadSec(page)).toBeGreaterThan(9);
    expect(await playheadSec(page)).toBeLessThan(13);
  });

  test("a touch in the lane above a glyph seeks", async ({ page }) => {
    await open(page);
    const [guest] = await boxes(
      page,
      `.lane-row[data-track-id="${GUEST}"] .edit-mark`,
    );
    const [above] = await boxes(page, lane);
    await page.touchscreen.tap(
      guest.x + guest.width / 2,
      above.y + above.height - 4,
    );
    await expect(joinDialog(page)).toHaveCount(0);
    expect(await playheadSec(page)).toBeGreaterThan(25);
    expect(await playheadSec(page)).toBeLessThan(35);
  });

  test("a long press 30 px beside a glyph opens the create menu", async ({
    page,
  }) => {
    await open(page);
    const box = await glyphAt(page, 0);
    const cdp = await page.context().newCDPSession(page);
    const at = { x: box.x - 30, y: box.y + box.height / 2 };
    await touch(cdp, "touchStart", [at]);
    await page.waitForTimeout(900);
    await expect(page.getByRole("menu", { name: /^Create at / })).toBeVisible();
    await touch(cdp, "touchEnd");
    await expect(joinDialog(page)).toHaveCount(0);
  });

  test("a touch on the roll seam at a glyph's join does not open the join", async ({
    page,
  }) => {
    await open(page);
    const [seam] = await boxes(page, `${lane} [data-hit-kind="roll"]`);
    await page.touchscreen.tap(
      seam.x + seam.width / 2,
      seam.y + seam.height / 2,
    );
    await expect(joinDialog(page)).toHaveCount(0);
  });

  test("a touch beside a glyph in blade mode cuts, not opens the join", async ({
    page,
  }) => {
    await open(page);
    await page.getByRole("button", { name: "Blade tool", exact: true }).click();
    const box = await glyphAt(page, 0);
    await page.touchscreen.tap(box.x + box.width + 20, box.y + box.height / 2);
    await expect(joinDialog(page)).toHaveCount(0);
    await expect(page.locator(`${lane} .edit-mark`).first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

test("a chip still zooms in blade mode", async ({ page }) => {
  await fiveJoins(page);
  await openFit(page, "desktop", "dark");
  await page.getByRole("button", { name: "Blade tool", exact: true }).click();
  const before = await rulerWidthPx(page);
  await page.locator(`${lane} .edit-chip`).click();
  await expect(page.locator(`${lane} .edit-chip`)).toHaveCount(0);
  expect(await rulerWidthPx(page)).toBeGreaterThan(before);
  await expect(page.getByRole("dialog", { name: /^Cut at / })).toHaveCount(0);
});
