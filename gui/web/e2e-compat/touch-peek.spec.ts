import { AxeBuilder } from "@axe-core/playwright";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "../e2e/axe";
import { e2eProjectPath } from "../e2e/env";
import {
  addEnvelopePoint,
  inspectEnvelopePoint,
  pointSheet,
  showEnvelope,
} from "../e2e/envelopeCreationEvidence";
import { type Finger, newFinger, type Point } from "../e2e/finger";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import { layer } from "../e2e/lifecycleAudit";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { inspectSelectionByKey, openProject } from "../e2e/stageNav";
import { ownsStudioAxe } from "../e2e/studioAxeOwnership";
import { setTheme, type Theme, withAppearance } from "../e2e/theme";
import {
  buildFixture,
  type CaseFixtures,
  centerOf,
  json,
  lane,
  projectJson,
  save,
  setZoom,
  watchCommands,
} from "../e2e/touchTimeline";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";

/*
 * #1051 round 3 on the real timeline, in Chromium (CDP touch) and WebKit
 * (touch-typed pointer events, see e2e/finger.ts): drag straight from a
 * chooser chip, no grab while the finger passes over chips or moves off the
 * target's axis, and the compact inspector (peek strip) that keeps the
 * selection in view, stows during a drag and remembers Expand. Evidence goes
 * to the test output and to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-touch-peek";
const HOLD_MS = LONG_PRESS_MS + 150;
/** Past `CHIP_SETTLE_MS`, with a frame to spare. */
const SETTLE_MS = 160;

const SIZES = {
  "portrait-360": { width: 360, height: 800 },
  "portrait-390": { width: 390, height: 844 },
  "landscape-600": { width: 600, height: 360 },
  "landscape-636": { width: 636, height: 390 },
} as const;
type SizeName = keyof typeof SIZES;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 600_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-peek-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function open(
  page: Page,
  size: SizeName,
  { theme = "dark" as Theme, inspector = "peek" } = {},
): Promise<void> {
  await page.setViewportSize(SIZES[size]);
  await openProject(page, projectPath);
  await page.evaluate((view) => {
    localStorage.setItem("sharecut.compactInspector", view);
  }, inspector);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  if (SIZES[size].width < 768) await openPhoneTimeline(page);
  await layer(page, "Volume envelope", true);
  await setTheme(page, theme);
  await expect(
    page.locator('circle[aria-label^="Envelope point 2"]'),
  ).toBeVisible();
  await setZoom(page, 3);
}

const chooser = (page: Page) =>
  page.locator(".target-chooser:not(.is-closing)");
const sheet = (page: Page) => page.locator(".bottom-sheet, .sys-inspector");

/** A tap that selects shuts the sheet it found; wait for that, if it happens. */
async function settleSheetShut(page: Page): Promise<void> {
  await expect(sheet(page))
    .toHaveCount(0, { timeout: 3000 })
    .catch(() => undefined);
}

/**
 * Inspect opens the sheet for the selection. The key toggles, and a tap that
 * retargets a sheet already up may leave it up or shut it, so look again and
 * press it once more if the sheet did not end up open.
 */
async function ensureInspected(page: Page): Promise<void> {
  if ((await page.locator(".bottom-sheet").count()) > 0) return;
  await inspectSelectionByKey(page);
}

async function centerOfBox(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const edgePoint = (page: Page) =>
  centerOf(
    page,
    `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-edge"]`,
  );

/** A quick tap low on the body of the clip that starts at 10 s, near its start. */
async function tapClipBody(page: Page, finger: Finger): Promise<void> {
  const project = (await projectJson(page, projectPath)) as unknown as {
    clips: { tracks: Record<string, { id: string; timeline_start: number }[]> };
  };
  const id = Object.values(project.clips.tracks)
    .flat()
    .find((c) => c.timeline_start === 10)?.id;
  const box = await page
    .locator(`${lane} .clip-block[data-clip-id="${id}"]`)
    .boundingBox({ timeout: 5000 });
  if (!box) throw new Error("clip 10-40 s has no box");
  await finger.down(
    await clearOfScrollbars(page, {
      x: box.x + box.width * 0.1,
      y: box.y + box.height * 0.9,
    }),
  );
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(600);
}

/** WebKit's overlay scrollbars hit-test as the scroller this far in (px). */
const SCROLLBAR_PX = 20;

/**
 * `p`, moved inside the timeline scroller clear of its scrollbars: a tap on
 * one hits the scroller, not the lane under it.
 */
async function clearOfScrollbars(page: Page, p: Point): Promise<Point> {
  return page.evaluate(
    ({ p, margin }) => {
      const s = document.querySelector(".timeline-scroll");
      if (!s) return p;
      const r = s.getBoundingClientRect();
      return {
        x: Math.min(p.x, r.left + s.clientLeft + s.clientWidth - margin),
        y: Math.min(p.y, r.top + s.clientTop + s.clientHeight - margin),
      };
    },
    { p, margin: SCROLLBAR_PX },
  );
}

async function tapTarget(
  page: Page,
  finger: Finger,
  locate: string,
): Promise<void> {
  const at = await page.evaluate((locate) => {
    const el = document.querySelector(locate);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el?.getBoundingClientRect();
    const lanes = document
      .querySelector(".timeline-scroll .clip-block")
      ?.closest(".lane-row")
      ?.getBoundingClientRect();
    if (!r || !lanes) return null;
    const left = Math.max(r.left, lanes.left);
    const right = Math.min(r.right, innerWidth);
    return {
      x: (left + right) / 2,
      y: r.top + r.height * (r.height > 40 ? 0.85 : 0.5),
    };
  }, locate);
  if (!at) throw new Error(`${locate} has no box`);
  await finger.down(await clearOfScrollbars(page, at));
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
  await ensureInspected(page);
}

/**
 * Holds on the edge cluster until the chooser opens; the finger stays down.
 * The clip after the edge is selected first, so its trim handle is there to
 * choose.
 */
async function holdOpen(page: Page, finger: Finger): Promise<Point> {
  if ((await page.locator(`${lane} .clip-block.selected`).count()) === 0) {
    await tapClipBody(page, finger);
  }
  const at = await edgePoint(page);
  await finger.down(at);
  await page.waitForTimeout(HOLD_MS);
  await expect(chooser(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  return at;
}

const trimChip = (page: Page) =>
  page.getByRole("menuitemradio", { name: /^Trim start/ });

/** Source start of the clip that starts at 10 s: what a Trim start drag moves. */
async function trimStartSec(page: Page): Promise<number> {
  const project = (await projectJson(page, projectPath)) as unknown as {
    clips: {
      tracks: Record<
        string,
        { timeline_start: number; source_start: number }[]
      >;
    };
  };
  const clip = Object.values(project.clips.tracks)
    .flat()
    .find((c) => c.timeline_start === 10);
  return clip?.source_start ?? Number.NaN;
}

/** What the strip or sheet shows, and whether it is stowed. */
async function sheetState(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".bottom-sheet, .sys-inspector");
    return {
      open: panel != null,
      sheetInert:
        panel?.closest(".bottom-sheet-root")?.hasAttribute("inert") ?? false,
      size:
        panel?.getAttribute("data-detent") ??
        [...(panel?.classList ?? [])]
          .find((c) => /^bottom-sheet--(peek|half|full)$/.test(c))
          ?.replace("bottom-sheet--", "") ??
        null,
      compact: panel?.classList.contains("bottom-sheet--compact") ?? false,
      stowed:
        panel?.closest(".bottom-sheet-root")?.classList.contains("is-stowed") ??
        false,
      title:
        panel?.querySelector(".bottom-sheet-title, .sys-sheet-title")
          ?.textContent ?? null,
      value: panel?.querySelector(".inspector-peek-value")?.textContent ?? null,
    };
  });
}

/**
 * Selected target against the strip or sheet over it: its bottom, the sheet's
 * top, and how many px of timeline lanes stay visible above the sheet.
 */
async function coverage(page: Page, locate: string) {
  return page.evaluate((locate) => {
    const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
    const target = box(document.querySelector(locate));
    const panel = box(document.querySelector(".bottom-sheet"));
    const scroller = document.querySelector(".timeline-scroll");
    const lanesTop = box(
      scroller?.querySelector(".marker-lane") ?? null,
    )?.bottom;
    const scrollBottom = box(scroller)?.bottom ?? 0;
    const floor = Math.min(panel?.top ?? Infinity, scrollBottom);
    return {
      targetTop: target ? Math.round(target.top) : null,
      targetBottom: target ? Math.round(target.bottom) : null,
      sheetTop: panel ? Math.round(panel.top) : null,
      lanesVisiblePx: lanesTop != null ? Math.round(floor - lanesTop) : null,
      targetVisible:
        target != null &&
        lanesTop != null &&
        target.top >= lanesTop - 1 &&
        target.bottom <= floor + 1,
    };
  }, locate);
}

async function frame(
  page: Page,
  info: Parameters<typeof save>[0],
  name: string,
) {
  save(info, `${name}.png`, await page.screenshot());
}

/** A fresh fixture on the phone timeline, and a finger on it. */
async function setUp(
  page: Page,
  context: BrowserContext,
  browserName: string,
): Promise<Finger> {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  await open(page, "portrait-360");
  return newFinger(context, page, browserName);
}

type Shot = (step: string) => Promise<void>;

/** Each way onto the Trim start chip, from a held chooser; returns nothing. */
const CHIP_CASES: Record<
  string,
  {
    moves: boolean;
    run: (page: Page, finger: Finger, shot: Shot) => Promise<void>;
  }
> = {
  "slid on, settled, slid along the axis": {
    moves: true,
    async run(page, finger, shot) {
      await holdOpen(page, finger);
      await shot("1-chooser");
      const chip = await centerOfBox(trimChip(page));
      await finger.slide(chip, 8, 16);
      await page.waitForTimeout(SETTLE_MS);
      await shot("2-armed");
      for (let k = 1; k <= 4; k += 1) {
        await finger.slide({ x: chip.x + 8 * k, y: chip.y + 1 }, 3, 16);
        await shot(`${2 + k}-dragging`);
      }
      await finger.up();
      await page.waitForTimeout(800);
      await shot("7-released");
    },
  },
  "lifted at the origin, chip pressed again, slid along the axis": {
    moves: true,
    async run(page, finger) {
      await holdOpen(page, finger);
      await finger.up();
      await page.waitForTimeout(150);
      const chip = await centerOfBox(trimChip(page));
      await finger.down(chip);
      await finger.slide({ x: chip.x + 30, y: chip.y }, 6, 16);
      await finger.up();
      await page.waitForTimeout(800);
    },
  },
  "slid on and lifted without moving": {
    moves: false,
    async run(page, finger) {
      await holdOpen(page, finger);
      await finger.slide(await centerOfBox(trimChip(page)), 8, 16);
      await page.waitForTimeout(SETTLE_MS);
      await finger.up();
      await page.waitForTimeout(600);
    },
  },
  "rested a long press, then dragged off the axis (fallback)": {
    moves: true,
    async run(page, finger) {
      await holdOpen(page, finger);
      const chip = await centerOfBox(trimChip(page));
      await finger.slide(chip, 8, 16);
      await page.waitForTimeout(HOLD_MS);
      await finger.slide({ x: chip.x + 30, y: chip.y + 20 }, 6, 16);
      await finger.up();
      await page.waitForTimeout(800);
    },
  },
};

async function chipCase(
  name: string,
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  const { moves, run } = CHIP_CASES[name];
  const finger = await setUp(page, context, browserName);
  const commands = watchCommands(page);
  const before = await trimStartSec(page);
  const slug = name.split(",")[0].replaceAll(" ", "-");
  await run(page, finger, (step) =>
    frame(page, info, `chip-${slug}-${browserName}-${step}`),
  );
  await ensureInspected(page);
  const row = {
    case: name,
    input: finger.input,
    before,
    after: await trimStartSec(page),
    commands: commands.map((c) => c.type),
    sheet: await sheetState(page),
  };
  json(info, `chip-${slug}-${browserName}`, row);
  if (moves) {
    // The save can land after the read above: wait for it.
    await expect.poll(() => trimStartSec(page)).toBeGreaterThan(row.before);
    expect(row.sheet).toMatchObject({
      compact: true,
      size: "peek",
      stowed: false,
      title: "Trim start",
    });
  } else {
    expect(row).toMatchObject({
      after: before,
      commands: [],
      sheet: { title: "Trim start", size: "peek" },
    });
  }
}

test("chip: slid on, settled, slid along the axis", ({
  page,
  context,
  browserName,
}, info) =>
  chipCase(
    "slid on, settled, slid along the axis",
    { page, context, browserName },
    info,
  ));

test("chip: lifted at the origin, chip pressed again, slid along the axis", ({
  page,
  context,
  browserName,
}, info) =>
  chipCase(
    "lifted at the origin, chip pressed again, slid along the axis",
    { page, context, browserName },
    info,
  ));

test("chip: slid on and lifted without moving", ({
  page,
  context,
  browserName,
}, info) =>
  chipCase(
    "slid on and lifted without moving",
    { page, context, browserName },
    info,
  ));

test("chip: rested a long press, then dragged off the axis (fallback)", ({
  page,
  context,
  browserName,
}, info) =>
  chipCase(
    "rested a long press, then dragged off the axis (fallback)",
    { page, context, browserName },
    info,
  ));

test("no grab while passing over chips or moving off the axis", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-360");
  const rows: Record<string, unknown>[] = [];
  const allChips = () =>
    page.getByRole("menuitemradio").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );

  for (const variant of ["sweep", "settle then vertical"] as const) {
    const commands = watchCommands(page);
    const before = await trimStartSec(page);
    await holdOpen(page, finger);
    const sheetBefore = await sheetState(page);
    const centers = await allChips();
    const row = centers[0].y;
    if (variant === "sweep") {
      // Quick sweep across every chip, about 0.75 px per ms, then off the row.
      await finger.slide({ x: centers[0].x - 30, y: row }, 6, 16);
      await finger.slide(
        { x: centers[centers.length - 1].x + 30, y: row },
        Math.ceil((centers[centers.length - 1].x - centers[0].x + 60) / 12),
        16,
      );
      await finger.slide(
        { x: centers[centers.length - 1].x + 30, y: row - 60 },
        4,
        16,
      );
    } else {
      const chip = await centerOfBox(trimChip(page));
      await finger.slide(chip, 8, 16);
      await page.waitForTimeout(SETTLE_MS);
      await finger.slide({ x: chip.x + 4, y: chip.y - 70 }, 6, 16);
    }
    await finger.up();
    await page.waitForTimeout(400);
    const open = (await chooser(page).count()) > 0;
    // A tap on the dimmed timeline closes the chips with no change.
    await finger.down({ x: 300, y: 470 });
    await finger.up();
    await page.waitForTimeout(400);
    rows.push({
      variant,
      chips: centers.length,
      before,
      after: await trimStartSec(page),
      chooserStillOpen: open,
      commands: commands.map((c) => c.type),
      sheetBefore,
      sheet: await sheetState(page),
    });
  }
  json(info, `no-accidental-grab-${browserName}`, {
    input: finger.input,
    rows,
  });
  for (const row of rows) {
    expect(row).toMatchObject({
      after: row.before,
      commands: [],
      chooserStillOpen: true,
      sheet: row.sheetBefore,
    });
  }
});

test("the strip and the expanded inspector leave the selection in view", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  // The lanes may still be loading after the fixture's commands.
  await expect(
    page.locator(".lane-row").nth(1).locator(".clip-block").first(),
  ).toBeAttached();
  const guestClip = await page.evaluate(
    () =>
      document
        .querySelectorAll(".lane-row")[1]
        ?.querySelector(".clip-block")
        ?.getAttribute("data-clip-id") ?? "",
  );
  // A lone envelope point on the first lane, and a clip on the second.
  const targets = {
    "lane 1 point": `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"]`,
    "lane 2 clip": `.clip-block[data-clip-id="${guestClip}"]`,
  };
  const rows: Record<string, unknown>[] = [];
  for (const size of Object.keys(SIZES) as SizeName[]) {
    for (const [target, locate] of Object.entries(targets)) {
      const record = async (state: string) => {
        rows.push({
          size,
          target,
          state,
          ...(await coverage(page, locate)),
          sheet: await sheetState(page),
        });
        if (size === "portrait-360" || size === "landscape-636") {
          const slug = target.replaceAll(" ", "-");
          const when = state.split(" ")[0];
          await frame(
            page,
            info,
            `cover-${size}-${slug}-${when}-${browserName}`,
          );
        }
      };
      await open(page, size);
      await tapTarget(page, finger, locate);
      await record("strip");
      await page
        .getByRole("button", { name: "Expand to half height" })
        .click({ timeout: 5000 });
      await page.waitForTimeout(700);
      await record("expanded");
    }
  }
  json(info, `coverage-${browserName}`, { input: finger.input, rows });
  for (const row of rows) {
    expect(row, JSON.stringify(row)).toMatchObject({ targetVisible: true });
  }
});

async function dragStowsStrip(
  size: "portrait-360" | "landscape-636",
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  const finger = await setUp(page, context, browserName);
  await open(page, size);
  // Select the trim start through the chooser: the strip opens on it.
  await holdOpen(page, finger);
  await finger.slide(await centerOfBox(trimChip(page)), 8, 16);
  await page.waitForTimeout(SETTLE_MS);
  await finger.up();
  await page.waitForTimeout(700);
  await ensureInspected(page);
  const opened = await sheetState(page);
  await frame(page, info, `stow-${size}-1-strip-${browserName}`);

  // Drag it again from a chip: the strip stows mid-drag. Stop just inside the
  // chip, so it settles under a resting finger, not one still sliding.
  const from = await holdOpen(page, finger);
  const chipBox = await trimChip(page).boundingBox({ timeout: 5000 });
  if (!chipBox) throw new Error("no trim chip");
  const inset = 4;
  const chip = {
    x: Math.min(
      Math.max(from.x, chipBox.x + inset),
      chipBox.x + chipBox.width - inset,
    ),
    y: Math.min(
      Math.max(from.y, chipBox.y + inset),
      chipBox.y + chipBox.height - inset,
    ),
  };
  await finger.slide(chip, 8, 16);
  await page.waitForTimeout(SETTLE_MS);
  await finger.slide({ x: chip.x + 30, y: chip.y }, 6, 16);
  await page.waitForTimeout(350);
  const mid = await sheetState(page);
  await frame(page, info, `stow-${size}-2-mid-drag-${browserName}`);
  const focusSteps = [];
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        sheet: !!element?.closest(".bottom-sheet-root"),
        tag: element?.tagName,
        label: element?.getAttribute("aria-label"),
        rect: element?.getBoundingClientRect().toJSON(),
      };
    });
    focusSteps.push(focused);
    if (focused.sheet) {
      json(info, `stowed-focus-${size}-${browserName}`, focusSteps);
    }
    expect(focused.sheet, JSON.stringify(focused)).toBe(false);
  }
  json(info, `stowed-focus-${size}-${browserName}`, focusSteps);
  await finger.up();
  await page.waitForTimeout(900);
  const released = await sheetState(page);
  await frame(page, info, `stow-${size}-3-released-${browserName}`);
  const restoredHeader = page.locator(
    ".bottom-sheet-header button:focus-visible",
  );
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    if (await restoredHeader.count()) break;
  }
  await expect(restoredHeader).toHaveCount(1);
  await expect(restoredHeader).toBeFocused();
  const restoredGeometry = await controlGeometry(restoredHeader);
  json(info, `restored-focus-${size}-${browserName}`, restoredGeometry);
  await frame(page, info, `restored-focus-${size}-${browserName}`);
  expect(restoredGeometry.fullyVisible).toBe(true);
  expect(restoredGeometry.hitsControl).toBe(true);
  expect(
    restoredGeometry.measured.every(
      (measurement) => measurement.admission.state === "admitted",
    ),
  ).toBe(true);
  expect(restoredGeometry.focusIndicator).toMatchObject({
    state: "outline",
    full: true,
    admission: { state: "admitted" },
  });

  // The selected trim's own handle under one moving finger: the grammar
  // scrolls, so nothing stows and nothing is edited (#1051 round 4b).
  // High on the strip: its middle sits under the edge's envelope point.
  const strip = await page
    .locator(`${lane} [data-hit-kind="trim-in"][data-hit-selected="true"]`)
    .boundingBox({ timeout: 5000 });
  if (!strip) throw new Error("no selected trim strip");
  const handle = {
    x: strip.x + strip.width / 2,
    y: strip.y + strip.height * 0.25,
  };
  await finger.down(handle);
  await finger.slide({ x: handle.x + 24, y: handle.y }, 8, 20);
  await page.waitForTimeout(300);
  const direct = await sheetState(page);
  await finger.up();
  await page.waitForTimeout(900);
  const row = {
    size,
    input: finger.input,
    opened,
    midChipDrag: mid,
    released,
    midHandleDrag: direct,
    afterHandleDrag: await sheetState(page),
    trimStartSec: await trimStartSec(page),
  };
  json(info, `stow-${size}-${browserName}`, row);
  expect(row.opened.sheetInert).toBe(false);
  expect(row.midChipDrag.sheetInert).toBe(true);
  expect(row.released.sheetInert).toBe(false);
  expect(row.midChipDrag.stowed).toBe(true);
  expect(row.released).toMatchObject({ stowed: false, title: "Trim start" });
  expect(row.released.value).not.toBe(row.opened.value);
  expect(row.midHandleDrag.stowed).toBe(false);
  expect(row.afterHandleDrag.value).toBe(row.released.value);
}

test("a drag stows the strip, which returns with the new value: portrait-360", ({
  page,
  context,
  browserName,
}, info) =>
  dragStowsStrip("portrait-360", { page, context, browserName }, info));

test("a drag stows the strip, which returns with the new value: landscape-636", ({
  page,
  context,
  browserName,
}, info) =>
  dragStowsStrip("landscape-636", { page, context, browserName }, info));

async function expandRemembered(
  size: "portrait-360" | "landscape-636",
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, size);
  const tap = async (at: Point) => {
    await finger.down(at);
    await page.waitForTimeout(60);
    await finger.up();
    await page.waitForTimeout(700);
  };
  const tapPoint = async (id: string) => {
    await tap(
      await centerOf(
        page,
        `${lane} [data-hit-kind="envelope-point"][data-hit-id="${id}"]`,
      ),
    );
    await ensureInspected(page);
  };
  /** A finger on the button where it is drawn; null if something covers it. */
  const tapButton = async (name: string) => {
    const at = await centerOfBox(page.getByRole("button", { name }));
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("button")
          ?.getAttribute("aria-label") ?? null,
      at,
    );
    await tap(at);
    return hit;
  };
  const steps: Record<string, unknown>[] = [];
  const step = async (name: string, buttonUnderFinger?: string | null) => {
    steps.push({
      step: name,
      ...(buttonUnderFinger !== undefined ? { buttonUnderFinger } : {}),
      ...(await sheetState(page)),
      pref: await page.evaluate(() =>
        localStorage.getItem("sharecut.compactInspector"),
      ),
    });
    await frame(
      page,
      info,
      `remember-${size}-${browserName}-${String(steps.length).padStart(2, "0")}`,
    );
  };
  await tapPoint("env-c");
  await step("select: strip");
  await step("one tap on Expand", await tapButton("Expand to half height"));
  await tapPoint("env-a");
  await step("next selection opens expanded");
  await step("collapse", await tapButton("Collapse to strip"));
  await tapPoint("env-c");
  await step("next selection opens the strip");
  json(info, `remember-${size}-${browserName}`, steps);
  expect(
    steps.map((s) => [s.size, s.pref, s.buttonUnderFinger ?? null]),
  ).toEqual([
    ["peek", "peek", null],
    ["half", "half", "Expand to half height"],
    ["half", "half", null],
    ["peek", "peek", "Collapse to strip"],
    ["peek", "peek", null],
  ]);
}

test("Expand is remembered for the next selection, and so is Collapse: portrait-360", ({
  page,
  context,
  browserName,
}, info) =>
  expandRemembered("portrait-360", { page, context, browserName }, info));

test("Expand is remembered for the next selection, and so is Collapse: landscape-636", ({
  page,
  context,
  browserName,
}, info) =>
  expandRemembered("landscape-636", { page, context, browserName }, info));

test("a pending edit's Approve and Reject stay reachable in pinned chrome at enlarged text sizes", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const commands = watchCommands(page);
  const finger = await newFinger(context, page, browserName);
  const rows: Record<string, unknown>[] = [];
  for (const rootFont of [16, 32]) {
    for (const size of ["portrait-390", "landscape-636"] as const) {
      await open(page, size);
      const at = await clearOfScrollbars(
        page,
        await centerOf(page, `${lane} [data-pending-id] >> nth=0`),
      );
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await ensureInspected(page);
      await page.evaluate((font) => {
        document.documentElement.style.fontSize = `${font}px`;
      }, rootFont);
      const card = page.locator(".pending-actionbar");
      await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
      const compact = page.locator(".bottom-sheet--compact");
      const expandTo =
        size === "landscape-636" && rootFont === 32 ? "full" : "half";
      await expect(
        compact.getByRole("button", { name: `Expand to ${expandTo} height` }),
      ).toBeVisible();
      await expect(
        compact.getByRole("button", { name: "Close" }),
      ).toBeVisible();
      await expect(
        compact.locator(".nudge-row").filter({ hasText: "Start" }),
      ).toBeVisible();
      await page.waitForTimeout(700);
      await frame(
        page,
        info,
        `pending-card-${size}-${rootFont}-${browserName}`,
      );
      rows.push({
        size,
        rootFont,
        ...(await page.evaluate(() => {
          const bar = document.querySelector(".pending-actionbar");
          const reach = (name: string) => {
            const button = [...(bar?.querySelectorAll("button") ?? [])].find(
              (b) => b.textContent?.trim() === name,
            );
            if (!button) return null;
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return {
              onScreen:
                r.top >= 0 &&
                r.bottom <= innerHeight &&
                r.left >= 0 &&
                r.right <= innerWidth,
              onTop: hit?.closest(".pending-actionbar") === bar,
              minTarget: r.width >= 44 && r.height >= 44,
              docked: Boolean(
                bar?.closest(".bottom-sheet-chrome") &&
                  bar.closest(".bottom-sheet--compact"),
              ),
            };
          };
          return {
            approve: reach("Approve"),
            reject: reach("Reject"),
            editTiming: [...(bar?.querySelectorAll("button") ?? [])].filter(
              (b) => b.textContent?.trim() === "Edit timing",
            ).length,
          };
        })),
      });
    }
  }
  json(info, `pending-card-${browserName}`, rows);
  const reachable = {
    onScreen: true,
    onTop: true,
    minTarget: true,
    docked: true,
  };
  for (const row of rows) {
    expect(row, JSON.stringify(row)).toMatchObject({
      approve: reachable,
      reject: reachable,
      editTiming: 0,
    });
  }
  const compact = page.locator(".bottom-sheet--compact");
  await compact.getByRole("button", { name: "Expand to full height" }).click();
  await expect(
    compact.getByRole("button", { name: "Collapse to strip" }),
  ).toBeVisible();
  await expect(compact.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(
    compact.getByRole("textbox", { name: "Source start", exact: true }),
  ).toBeVisible();
  await compact.getByRole("button", { name: "Collapse to strip" }).click();
  const previousIds = (await projectJson(page, projectPath)).pending_edits.map(
    (edit) => edit.id,
  );
  await page
    .locator(".pending-actionbar")
    .getByRole("button", { name: "Reject" })
    .click();
  await expect
    .poll(
      async () => (await projectJson(page, projectPath)).pending_edits.length,
    )
    .toBe(previousIds.length - 1);
  expect(commands).toContainEqual({
    type: "RejectEdits",
    payload: { ids: [expect.any(String)] },
  });
});

test("both themes and reduced motion with the strip open", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  const rows: Record<string, unknown>[] = [];
  for (const { theme, reducedMotion } of withAppearance([0, 1])) {
    const motion = reducedMotion ? "reduce" : "no-preference";
    await page.emulateMedia({ reducedMotion: motion });
    await open(page, "portrait-360", { theme });
    await holdOpen(page, finger);
    await finger.slide(await centerOfBox(trimChip(page)), 8, 16);
    await page.waitForTimeout(SETTLE_MS);
    await finger.up();
    await page.waitForTimeout(700);
    await ensureInspected(page);
    const axeStrip = ownsStudioAxe({ suite: "compat", engine: browserName })
      ? await new AxeBuilder({ page })
          .disableRules([...STUDIO_AXE_DISABLED_RULES])
          .include(".bottom-sheet")
          .analyze()
      : undefined;
    await frame(page, info, `strip-${theme}-${motion}-${browserName}`);
    const transition = await sheet(page).evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    const nudges = await page.locator(".nudge-button").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return {
          label: e.getAttribute("aria-label"),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }),
    );
    await page.getByRole("button", { name: "Expand to half height" }).click();
    await page.waitForTimeout(600);
    const axeExpanded = ownsStudioAxe({ suite: "compat", engine: browserName })
      ? await new AxeBuilder({ page })
          .disableRules([...STUDIO_AXE_DISABLED_RULES])
          .include(".bottom-sheet")
          .analyze()
      : undefined;
    rows.push({
      motion,
      theme,
      transition,
      nudges,
      ...(axeStrip ? { axeStrip: axeStrip.violations.map((v) => v.id) } : {}),
      ...(axeExpanded
        ? { axeExpanded: axeExpanded.violations.map((v) => v.id) }
        : {}),
    });
  }
  json(info, `axe-theme-motion-${browserName}`, rows);
  for (const row of rows as {
    motion: string;
    transition: string;
    nudges: { label: string; w: number; h: number }[];
    axeStrip?: string[];
    axeExpanded?: string[];
  }[]) {
    if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
      expect(row.axeStrip).toEqual([]);
      expect(row.axeExpanded).toEqual([]);
    }
    expect(row.nudges.map((n) => n.label)).toEqual([
      "Trim start 0.1 s earlier",
      "Trim start 0.01 s earlier",
      "Trim start 0.01 s later",
      "Trim start 0.1 s later",
    ]);
    for (const n of row.nudges) {
      expect(Math.min(n.w, n.h)).toBeGreaterThanOrEqual(44);
    }
    if (row.motion === "reduce") expect(row.transition).toBe("0s");
  }
});

const envC = `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"]`;

async function tapBox(
  page: Page,
  finger: Finger,
  locator: Locator,
): Promise<void> {
  await finger.down(await centerOfBox(locator));
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
}

async function drawerChrome(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".bottom-sheet");
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const reach = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return {
        inView:
          r.top >= 0 &&
          r.left >= 0 &&
          r.bottom <= innerHeight &&
          r.right <= innerWidth,
        w: Math.round(r.width),
        h: Math.round(r.height),
        onTop: hit != null && (el.contains(hit) || hit.contains(el)),
      };
    };
    const buttons = [...(panel?.querySelectorAll("button") ?? [])];
    const named = (prefix: string) =>
      buttons.find((b) => b.getAttribute("aria-label")?.startsWith(prefix));
    const chrome = panel?.querySelector(".bottom-sheet-chrome");
    const title = panel?.querySelector(".bottom-sheet-title");
    // line-height is `normal` (about 1.2 em), so a line is read off the font size.
    const fontPx = title
      ? Number.parseFloat(getComputedStyle(title).fontSize)
      : 0;
    return {
      titleLines: title
        ? Math.round(title.getBoundingClientRect().height / (fontPx * 1.3))
        : 0,
      rootPx: rem,
      sheetPx: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      chromePx: chrome ? Math.round(chrome.getBoundingClientRect().height) : 0,
      header: reach(panel?.querySelector(".bottom-sheet-title")),
      collapse: reach(named("Collapse")),
      close: reach(named("Close")),
    };
  });
}

const SHEET_REACHABLE = { inView: true, onTop: true };

async function expandAtRootFont(
  rootPx: number,
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "landscape-636");
  await tapTarget(page, finger, envC);
  await expect(sheet(page)).toHaveClass(/bottom-sheet--peek/);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(300);
  const rows: Record<string, unknown>[] = [];
  const fullOnly = rootPx === 32;
  for (const detent of fullOnly
    ? (["full"] as const)
    : (["half", "full"] as const)) {
    await tapBox(
      page,
      finger,
      page.getByRole("button", { name: `Expand to ${detent} height` }),
    );
    await expect(sheet(page)).toHaveClass(
      new RegExp(`bottom-sheet--${detent}`),
    );
    const row = { detent, ...(await drawerChrome(page)) };
    rows.push(row);
    await frame(page, info, `expand-${rootPx}px-${detent}-${browserName}`);
    expect(row, JSON.stringify(row)).toMatchObject({
      header: SHEET_REACHABLE,
      collapse: SHEET_REACHABLE,
      close: SHEET_REACHABLE,
    });
    for (const control of [row.collapse, row.close]) {
      expect(Math.min(control?.w ?? 0, control?.h ?? 0)).toBeGreaterThanOrEqual(
        44,
      );
    }
    expect(row.sheetPx - row.chromePx).toBeGreaterThanOrEqual(3 * rootPx);
  }
  json(info, `expand-${rootPx}px-${browserName}`, rows);
  await tapBox(page, finger, page.getByRole("button", { name: /^Collapse/ }));
  await expect(sheet(page)).toHaveClass(/bottom-sheet--peek/);
}

test("Expand keeps the header, Collapse and Close usable at 636x390 with a 16 px root font", ({
  page,
  context,
  browserName,
}, info) => expandAtRootFont(16, { page, context, browserName }, info));

test("Expand keeps the header, Collapse and Close usable at 636x390 with a 32 px root font", ({
  page,
  context,
  browserName,
}, info) => expandAtRootFont(32, { page, context, browserName }, info));

/**
 * The half drawer on a 390 px phone: with Collapse, Expand and Close at large
 * text the actions cannot sit beside the title, so they wrap beneath it and
 * the title keeps a readable line of its own.
 */
async function halfTitleAtRootFont(
  rootPx: number,
  { page, context, browserName }: CaseFixtures,
  info: TestInfo,
): Promise<void> {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390");
  await tapTarget(page, finger, envC);
  await expect(sheet(page)).toHaveClass(/bottom-sheet--peek/);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(300);
  await tapBox(
    page,
    finger,
    page.getByRole("button", { name: "Expand to half height" }),
  );
  await expect(sheet(page)).toHaveClass(/bottom-sheet--half/);
  const row = await drawerChrome(page);
  await frame(page, info, `half-title-${rootPx}px-${browserName}`);
  json(info, `half-title-${rootPx}px-${browserName}`, row);
  expect(row.header?.w ?? 0, JSON.stringify(row)).toBeGreaterThanOrEqual(
    8 * rootPx,
  );
  expect(row.titleLines).toBe(1);
  expect(row).toMatchObject({
    header: SHEET_REACHABLE,
    collapse: SHEET_REACHABLE,
    close: SHEET_REACHABLE,
  });
}

test("the half drawer keeps a readable title at 390x844 with a 16 px root font", ({
  page,
  context,
  browserName,
}, info) => halfTitleAtRootFont(16, { page, context, browserName }, info));

test("the half drawer keeps a readable title at 390x844 with a 32 px root font", ({
  page,
  context,
  browserName,
}, info) => halfTitleAtRootFont(32, { page, context, browserName }, info));

async function openTrackSheet(page: Page, finger: Finger): Promise<void> {
  await tapBox(page, finger, page.locator(".track-header-open").first());
  await expect(sheet(page)).toBeVisible();
  expect((await sheetState(page)).compact).toBe(false);
}

test("a timeline tap while a track's sheet is open selects, and Inspect opens the strip: portrait-390", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390");
  await openTrackSheet(page, finger);
  const track = await sheetState(page);
  await frame(page, info, `tap-while-track-sheet-1-track-${browserName}`);
  await tapClipBody(page, finger);
  // Selecting shuts the track's sheet; Inspect opens the clip's strip.
  await settleSheetShut(page);
  await ensureInspected(page);
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  const clip = await sheetState(page);
  await frame(page, info, `tap-while-track-sheet-2-clip-${browserName}`);
  json(info, `tap-while-track-sheet-${browserName}`, { track, clip });
  expect(clip).toMatchObject({ compact: true, size: "peek", stowed: false });
  expect(await page.locator(".bottom-sheet .inspector").count()).toBe(0);
  await tapTarget(page, finger, envC);
  await settleSheetShut(page);
  await ensureInspected(page);
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  expect(await sheetState(page)).toMatchObject({
    compact: true,
    size: "peek",
    title: "Envelope point",
  });
});

test("a point added from a track's sheet shows its fields in the drawer: portrait-390", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390", { inspector: "half" });
  await openTrackSheet(page, finger);
  await showEnvelope(page);
  await addEnvelopePoint(page, { share: 0.9 });
  await inspectEnvelopePoint(page);
  const time = pointSheet(page).getByRole("spinbutton", {
    name: "Time",
    exact: true,
  });
  await expect(time).toBeVisible();
  const kept = {
    ...(await sheetState(page)),
    pointFieldInSheet: await time.evaluate(
      (el) => el.closest(".bottom-sheet, .sys-inspector") != null,
    ),
  };
  await frame(page, info, `added-point-in-drawer-${browserName}`);
  json(info, `added-point-in-drawer-${browserName}`, kept);
  expect(kept).toMatchObject({ open: true, pointFieldInSheet: true });
});

async function focusedField(page: Page) {
  return page.evaluate(() => {
    const chrome = document.querySelector(".bottom-sheet-chrome");
    const body = document.querySelector(".bottom-sheet-body");
    const el = document.activeElement;
    if (!chrome || !body || !el || !body.contains(el)) return null;
    const r = el.getBoundingClientRect();
    return {
      field: el.getAttribute("aria-label") ?? el.id ?? el.tagName,
      top: Math.round(r.top),
      headerBottom: Math.round(chrome.getBoundingClientRect().bottom),
    };
  });
}

test("Tab focus never lands a field under the drawer header at 32 px text: a pending cut", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390", { inspector: "full" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await page.waitForTimeout(300);
  await tapTarget(page, finger, `${lane} [data-pending-id]`);
  await expect(sheet(page)).toHaveClass(/bottom-sheet--full/);
  const fields = page.locator(
    ".bottom-sheet-body input:not([type=hidden]), .bottom-sheet-body select, .bottom-sheet-body textarea",
  );
  expect(await fields.count()).toBeGreaterThan(1);
  await fields.last().focus();
  const seen: NonNullable<Awaited<ReturnType<typeof focusedField>>>[] = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(80);
    const at = await focusedField(page);
    if (!at) break;
    seen.push(at);
  }
  await frame(page, info, `tab-up-pending-32px-${browserName}`);
  json(info, `tab-up-pending-32px-${browserName}`, seen);
  expect(seen.length).toBeGreaterThan(0);
  for (const at of seen) {
    expect(at.top, JSON.stringify(at)).toBeGreaterThanOrEqual(at.headerBottom);
  }

  const partly: Record<string, unknown>[] = [];
  const count = await fields.count();
  for (let i = 0; i < count; i += 1) {
    for (const under of [4, 7, 20, 40]) {
      partly.push(
        await fields.nth(i).evaluate((el, under) => {
          const input = el as HTMLElement;
          const chrome = document.querySelector(".bottom-sheet-chrome");
          let scroller = input.parentElement;
          while (
            scroller &&
            !(
              /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
              scroller.scrollHeight > scroller.clientHeight
            )
          ) {
            scroller = scroller.parentElement;
          }
          if (!chrome || !scroller) return { skipped: "no scroller" };
          const bottom = chrome.getBoundingClientRect().bottom;
          scroller.scrollTop +=
            input.getBoundingClientRect().top - (bottom - under);
          const placed = Math.round(input.getBoundingClientRect().top);
          if (Math.abs(placed - (bottom - under)) > 1) {
            return { skipped: "cannot place", under };
          }
          input.blur();
          input.focus();
          return {
            under,
            field: input.getAttribute("aria-label") ?? input.id,
            top: Math.round(input.getBoundingClientRect().top),
            headerBottom: Math.round(bottom),
          };
        }, under),
      );
    }
  }
  json(info, `partly-under-pending-32px-${browserName}`, partly);
  const placed = partly.filter((row) => !("skipped" in row)) as {
    top: number;
    headerBottom: number;
  }[];
  expect(placed.length).toBeGreaterThan(0);
  for (const at of placed) {
    expect(at.top, JSON.stringify(at)).toBeGreaterThanOrEqual(at.headerBottom);
  }
});

test("the strip leaves the timeline undimmed and the half sheet dims it: portrait-390", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390");
  await tapTarget(page, finger, envC);
  const scrim = () =>
    page.evaluate(() => {
      const scrim = document.querySelector(".bottom-sheet-scrim");
      const area = document
        .querySelector(".timeline-scroll")
        ?.getBoundingClientRect();
      const hit = area
        ? document.elementFromPoint(area.left + area.width / 2, area.top + 6)
        : null;
      return {
        background: scrim ? getComputedStyle(scrim).backgroundColor : null,
        timelineHitsScrim:
          hit?.classList.contains("bottom-sheet-scrim") ?? null,
        hit: hit?.className?.toString() ?? null,
      };
    });
  const strip = await scrim();
  await frame(page, info, `scrim-1-strip-${browserName}`);
  await tapBox(
    page,
    finger,
    page.getByRole("button", { name: "Expand to half height" }),
  );
  await expect(sheet(page)).toHaveClass(/bottom-sheet--half/);
  const half = await scrim();
  await frame(page, info, `scrim-2-half-${browserName}`);
  json(info, `scrim-${browserName}`, { strip, half });
  expect(strip).toMatchObject({
    background: "rgba(0, 0, 0, 0)",
    timelineHitsScrim: false,
  });
  expect(half.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(half.timelineHitsScrim).toBe(false);
});
