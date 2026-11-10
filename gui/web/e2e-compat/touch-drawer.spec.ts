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
} from "../e2e/envelopeCreationEvidence";
import { type Finger, newFinger, type Point } from "../e2e/finger";
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
 * target's axis, and the phone Inspector sheet (dock, half and full) that
 * keeps the selection in view above it, carries the Action bar as its dock,
 * toggles from its grip and clears the selection when dragged below the dock.
 * Evidence goes to the test output and to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-touch-drawer";
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
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-drawer-");
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
  { theme = "dark" as Theme } = {},
): Promise<void> {
  await page.setViewportSize(SIZES[size]);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  if (SIZES[size].width < 768) await openPhoneTimeline(page);
  await layer(page, "Volume envelope", true);
  await setTheme(page, theme);
  await expect(
    page.getByRole("slider", { name: "Envelope point 2", exact: true }),
  ).toBeVisible();
  await setZoom(page, 3);
}

const chooser = (page: Page) => page.locator(".edit-target-chooser");
const sheet = (page: Page) => page.locator(".sys-inspector--phone");

async function settleSheetShut(page: Page): Promise<void> {
  await expect(sheet(page)).toHaveCount(0, { timeout: 3000 });
}

/**
 * Inspect opens the sheet for the selection. The key toggles, and a tap that
 * retargets a sheet already up may leave it up or shut it, so look again and
 * press it once more if the sheet did not end up open.
 */
async function ensureInspected(page: Page): Promise<void> {
  if ((await sheet(page).count()) > 0) return;
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
async function tapClipBody(page: Page, finger: Finger): Promise<string> {
  const project = (await projectJson(page, projectPath)) as unknown as {
    clips: { tracks: Record<string, { id: string; timeline_start: number }[]> };
  };
  const id = Object.values(project.clips.tracks)
    .flat()
    .find((c) => c.timeline_start === 10)?.id;
  const box = await page
    .locator(`${lane} .clip-block[data-clip-id="${id}"]`)
    .boundingBox({ timeout: 5000 });
  if (!box || !id) throw new Error("clip 10-40 s has no box");
  await finger.down(
    await uncoveredPoint(page, {
      x: box.x + box.width * 0.1,
      ys: [0.9, 0.75, 0.6, 0.45, 0.3].map((f) => box.y + box.height * f),
      hits: `${lane} .clip-block[data-clip-id="${id}"]`,
    }),
  );
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(600);
  return id;
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

/**
 * A tall lane puts the low part of a clip under the floating Edit corner or the
 * open sheet; a user taps the part still in view.
 * Falls back to the first, so a target that is covered everywhere still fails.
 */
async function uncoveredPoint(
  page: Page,
  { x, ys, hits }: { x: number; ys: number[]; hits: string },
): Promise<Point> {
  const candidates = await Promise.all(
    ys.map((y) => clearOfScrollbars(page, { x, y })),
  );
  const open = await page.evaluate(
    ({ candidates, hits }) => {
      const wanted = document.querySelector(hits);
      return candidates.findIndex((p) => {
        const top = document.elementFromPoint(p.x, p.y);
        return !!wanted && !!top && wanted.contains(top);
      });
    },
    { candidates, hits },
  );
  return candidates[Math.max(open, 0)]!;
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
      ys: (r.height > 40 ? [0.85, 0.7, 0.55, 0.4, 0.25] : [0.5]).map(
        (f) => r.top + r.height * f,
      ),
    };
  }, locate);
  if (!at) throw new Error(`${locate} has no box`);
  await finger.down(await uncoveredPoint(page, { ...at, hits: locate }));
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
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
  chooser(page).getByRole("menuitem", { name: /^Clip, Trim start at / });

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

/** What the Inspector sheet shows: its detent, its heading and the Source start field. */
async function sheetState(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".sys-inspector--phone");
    return {
      open: panel != null,
      size: panel?.getAttribute("data-detent") ?? null,
      title:
        panel?.querySelector(".sys-inspector-header .sys-sheet-title")
          ?.textContent ?? null,
      // The Scrub field the trim moves; the sheet shows its value.
      sourceStart:
        panel
          ?.querySelector('[role="spinbutton"][aria-label="Source start"]')
          ?.getAttribute("aria-valuenow") ?? null,
    };
  });
}

/**
 * Selected target against the drawer or sheet over it: its bottom, the sheet's
 * top, and how many px of timeline lanes stay visible above the sheet.
 */
async function coverage(page: Page, locate: string) {
  return page.evaluate((locate) => {
    const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
    const target = box(document.querySelector(locate));
    const panel = box(document.querySelector(".sys-inspector--phone"));
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
  "rested a long press, then dragged off the axis (no grab)": {
    moves: false,
    async run(page, finger) {
      await holdOpen(page, finger);
      const chip = await centerOfBox(trimChip(page));
      await finger.slide(chip, 8, 16);
      await page.waitForTimeout(HOLD_MS);
      await finger.slide({ x: chip.x + 30, y: chip.y + 20 }, 6, 16);
      await finger.slide(chip, 6, 16);
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
    expect(row.sheet).toMatchObject({ open: true, size: "half" });
  } else {
    expect(row).toMatchObject({
      after: before,
      commands: [],
      sheet: { open: true, size: "half" },
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

test("chip: rested a long press, then dragged off the axis (no grab)", ({
  page,
  context,
  browserName,
}, info) =>
  chipCase(
    "rested a long press, then dragged off the axis (no grab)",
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
    chooser(page)
      .getByRole("menuitem")
      .evaluateAll((els) =>
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

const grip = (page: Page) => page.getByRole("slider", { name: "Sheet height" });
const sheetDock = (page: Page) =>
  sheet(page).getByRole("group", { name: "Edit actions" });
const history = (page: Page) => page.locator(".sys-app-header-host");

test("the half sheet leaves the selection in view; the dock detent keeps its verbs; the grip toggles them", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
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
    // The drawn dot: its 44 px touch box may reach past the lane at a high level.
    "lane 1 point": `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"] .sys-env-dot`,
    "lane 2 clip": `.clip-block[data-clip-id="${guestClip}"]`,
  };
  const rows: Record<string, unknown>[] = [];
  const fullOnly: SizeName[] = [];
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
          await frame(
            page,
            info,
            `cover-${size}-${slug}-${state}-${browserName}`,
          );
        }
      };
      await open(page, size);
      await tapTarget(page, finger, locate);
      await ensureInspected(page);
      // A lane area too short for half and the dock opens the sheet full-only.
      const opened = await sheet(page).getAttribute("data-detent");
      rows.push({ size, target, opened });
      if (opened === "full") {
        fullOnly.push(size);
        continue;
      }
      expect(opened).toBe("half");
      await record("half");
      // Half: the dock is the sheet's first row, and Undo is in the header.
      await expect(sheetDock(page)).toBeVisible();
      await expect(
        sheetDock(page).getByRole("button", { name: /^Hear/ }),
      ).toBeVisible();
      await expect(
        history(page).getByRole("button", { name: "Undo", exact: true }),
      ).toBeVisible();
      // The grip toggles half and dock; the dock detent keeps its verbs.
      await grip(page).click();
      await expect(sheet(page)).toHaveAttribute("data-detent", "dock");
      await page.waitForTimeout(500);
      await record("dock");
      await expect(sheetDock(page)).toBeVisible();
      await expect(
        sheetDock(page).getByRole("button", { name: /^Hear/ }),
      ).toBeVisible();
      await grip(page).click();
      await expect(sheet(page)).toHaveAttribute("data-detent", "half");
    }
  }
  json(info, `coverage-${browserName}`, { input: finger.input, rows });
  // Half and dock leave the target clear; the full sheet covers the lanes by design.
  for (const row of rows.filter((r) => "targetVisible" in r)) {
    expect(row, JSON.stringify(row)).toMatchObject({ targetVisible: true });
  }
  // The portrait phone at 390 x 844 always has room for half.
  expect(fullOnly).not.toContain("portrait-390");
  expect(
    rows.filter((r) => r.size === "portrait-390" && r.state === "half"),
  ).toHaveLength(2);
});

test("dragging the grip down past the dock clears the selection: portrait-390", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390");
  await tapClipBody(page, finger);
  await ensureInspected(page);
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  await expect(page.locator(`${lane} .clip-block.selected`)).toHaveCount(1);
  const from = await centerOfBox(grip(page));
  await finger.down(from);
  await finger.slide({ x: from.x, y: from.y + 380 }, 12, 16);
  await finger.up();
  await page.waitForTimeout(700);
  await frame(page, info, `swipe-dismiss-${browserName}`);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator(`${lane} .clip-block.selected`)).toHaveCount(0);
});

test("a pending edit's review card tops the sheet and its Approve and Reject stay reachable at enlarged text sizes", async ({
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
      const pendingId = await page
        .locator(`${lane} [data-pending-id]`)
        .first()
        .getAttribute("data-pending-id");
      const pendingTarget = `${lane} [data-pending-id="${pendingId}"]`;
      const at = await clearOfScrollbars(
        page,
        await centerOf(page, pendingTarget),
      );
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await expect(
        page.locator(`${pendingTarget} .pending-hit`),
      ).toHaveAttribute("aria-pressed", "true");
      await ensureInspected(page);
      await page.evaluate((font) => {
        document.documentElement.style.fontSize = `${font}px`;
      }, rootFont);
      const card = page.locator(".pending-actionbar");
      await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
      // Half does not fit a phone held sideways, nor 32 px text: full-only.
      // Sideways at 32 px even the full sheet is under 8.75 rem: the Inspector
      // takes the whole screen as a dialog with a Done button.
      const takeover = size === "landscape-636" && rootFont === 32;
      if (takeover) {
        const dialog = page.locator(".sys-inspector-takeover");
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Done" }),
        ).toBeVisible();
      } else {
        const fullOnly = size === "landscape-636" || rootFont === 32;
        await expect(sheet(page)).toHaveAttribute(
          "data-detent",
          fullOnly ? "full" : "half",
        );
        await expect(
          sheet(page).getByRole("button", { name: "Close" }),
        ).toBeVisible();
        await expect(
          sheet(page).getByRole("spinbutton", { name: "Source start" }),
        ).toBeAttached();
      }
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
          const scroll = document.querySelector(".sys-inspector-scroll");
          const reach = (name: string) => {
            const button = [...(bar?.querySelectorAll("button") ?? [])].find(
              (b) => b.textContent?.trim() === name,
            );
            if (!button) return null;
            // The card scrolls with the sheet body: bring the button into view first.
            button.scrollIntoView({ block: "center", behavior: "instant" });
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
                bar &&
                  scroll?.contains(bar) &&
                  scroll.firstElementChild?.contains(bar),
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

test("both themes and reduced motion with the sheet open", async ({
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
    await tapClipBody(page, finger);
    await ensureInspected(page);
    const analyze = () =>
      ownsStudioAxe({ suite: "compat", engine: browserName })
        ? new AxeBuilder({ page })
            .disableRules([...STUDIO_AXE_DISABLED_RULES])
            .include(".sys-inspector--phone")
            .analyze()
        : undefined;
    const axeHalf = await analyze();
    await frame(page, info, `sheet-${theme}-${motion}-${browserName}`);
    await grip(page).focus();
    await page.keyboard.press("End");
    await expect(sheet(page)).toHaveAttribute("data-detent", "full");
    await page.waitForTimeout(600);
    const axeFull = await analyze();
    rows.push({
      motion,
      theme,
      ...(axeHalf ? { axeHalf: axeHalf.violations.map((v) => v.id) } : {}),
      ...(axeFull ? { axeFull: axeFull.violations.map((v) => v.id) } : {}),
    });
  }
  json(info, `axe-theme-motion-${browserName}`, rows);
  for (const row of rows as { axeHalf?: string[]; axeFull?: string[] }[]) {
    if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
      expect(row.axeHalf).toEqual([]);
      expect(row.axeFull).toEqual([]);
    }
  }
});

async function openTrackSheet(page: Page, finger: Finger): Promise<void> {
  await tapBox(page, finger, page.locator(".sys-track-main").first());
  await expect(sheet(page)).toBeVisible();
}

test("a timeline tap while a track's sheet is open selects, and Inspect opens the sheet at half: portrait-390", async ({
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
  const intendedClip = await tapClipBody(page, finger);
  await expect(
    page.locator(
      `${lane} .clip-block[data-clip-id="${intendedClip}"] .clip-hit`,
    ),
  ).toHaveAttribute("aria-pressed", "true");
  await settleSheetShut(page);
  await ensureInspected(page);
  await expect(sheet(page)).toBeVisible();
  const clip = await sheetState(page);
  await frame(page, info, `tap-while-track-sheet-2-clip-${browserName}`);
  json(info, `tap-while-track-sheet-${browserName}`, { track, clip });
  expect(clip).toMatchObject({ open: true, size: "half" });
  await tapTarget(page, finger, envC);
  await expect(page.locator(envC)).toHaveAttribute("data-selected", "true");
  await settleSheetShut(page);
  await ensureInspected(page);
  await expect(sheet(page)).toBeVisible();
  expect(await sheetState(page)).toMatchObject({
    open: true,
    size: "half",
    title: expect.stringMatching(/point/i),
  });
});

test("a point added from a track's sheet shows its fields in the sheet: portrait-390", async ({
  page,
  context,
  browserName,
}, info) => {
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  await open(page, "portrait-390");
  await openTrackSheet(page, finger);
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
      (el) => el.closest(".sys-inspector") != null,
    ),
  };
  await frame(page, info, `added-point-in-sheet-${browserName}`);
  json(info, `added-point-in-sheet-${browserName}`, kept);
  expect(kept).toMatchObject({ open: true, pointFieldInSheet: true });
});
