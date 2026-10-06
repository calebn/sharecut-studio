import { AxeBuilder } from "@axe-core/playwright";
import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "../e2e/axe";
import { e2eProjectPath } from "../e2e/env";
import { type Finger, newFinger, type Point } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme, type Theme } from "../e2e/theme";
import {
  buildFixture,
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
  "landscape-800": { width: 800, height: 360 },
  "landscape-844": { width: 844, height: 390 },
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
  { lab = true, theme = "dark" as Theme, inspector = "strip" } = {},
): Promise<void> {
  await page.setViewportSize(SIZES[size]);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await page.evaluate((view) => {
    localStorage.setItem("sharecut.compactInspector", view);
  }, inspector);
  await page.goto(
    `/?project=${encodeURIComponent(projectPath)}&lab=${lab ? "" : "-"}touch-chooser`,
  );
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (SIZES[size].width < 768) await openPhoneTimeline(page);
  await setTheme(page, theme);
  await expect(
    page.locator('circle[aria-label^="Envelope point 2"]'),
  ).toBeVisible();
  await setZoom(page, 3);
}

const chooser = (page: Page) =>
  page.locator(".target-chooser:not(.is-closing)");
const sheet = (page: Page) => page.locator(".bottom-sheet");

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
    const panel = document.querySelector(".bottom-sheet");
    return {
      open: panel != null,
      size:
        [...(panel?.classList ?? [])]
          .find((c) => /^bottom-sheet--(peek|half|full)$/.test(c))
          ?.replace("bottom-sheet--", "") ?? null,
      compact: panel?.classList.contains("bottom-sheet--compact") ?? false,
      stowed:
        panel?.closest(".bottom-sheet-root")?.classList.contains("is-stowed") ??
        false,
      title: panel?.querySelector(".bottom-sheet-title")?.textContent ?? null,
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
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
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

for (const [name, { moves, run }] of Object.entries(CHIP_CASES)) {
  test(`chip: ${name}`, async ({ page, context, browserName }, info) => {
    const finger = await setUp(page, context, browserName);
    const commands = watchCommands(page);
    const before = await trimStartSec(page);
    const slug = name.split(",")[0].replaceAll(" ", "-");
    await run(page, finger, (step) =>
      frame(page, info, `chip-${slug}-${browserName}-${step}`),
    );
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
      expect(row.after).toBeGreaterThan(row.before);
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
  });
}

test("no grab while passing over chips or moving off the axis", async ({
  page,
  context,
  browserName,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
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
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
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
  const tap = async (locate: string) => {
    // The middle of the target's part inside the lanes' visible box.
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
        if (size === "portrait-360" || size === "landscape-844") {
          const slug = target.replaceAll(" ", "-");
          const when = state.split(" ")[0];
          await frame(
            page,
            info,
            `cover-${size}-${slug}-${when}-${browserName}`,
          );
        }
      };
      // Before: round 2's half sheet (lab off).
      await open(page, size, { lab: false });
      await tap(locate);
      await record("before (lab off)");
      // After: the strip, then expanded.
      await open(page, size);
      await tap(locate);
      await record("strip");
      await page
        .getByRole("button", { name: "Expand to the full inspector" })
        .click({ timeout: 5000 });
      await page.waitForTimeout(700);
      await record("expanded");
    }
  }
  json(info, `coverage-${browserName}`, { input: finger.input, rows });
  for (const row of rows.filter((r) => r.state !== "before (lab off)")) {
    expect(row, JSON.stringify(row)).toMatchObject({ targetVisible: true });
  }
});

for (const size of ["portrait-360", "landscape-844"] as const) {
  test(`a drag stows the strip, which returns with the new value: ${size}`, async ({
    page,
    context,
    browserName,
  }, info) => {
    const finger = await setUp(page, context, browserName);
    await open(page, size);
    // Select the trim start through the chooser: the strip opens on it.
    await holdOpen(page, finger);
    await finger.slide(await centerOfBox(trimChip(page)), 8, 16);
    await page.waitForTimeout(SETTLE_MS);
    await finger.up();
    await page.waitForTimeout(700);
    const opened = await sheetState(page);
    await frame(page, info, `stow-${size}-1-strip-${browserName}`);

    // Drag it again from a chip: the strip stows mid-drag.
    await holdOpen(page, finger);
    const chip = await centerOfBox(trimChip(page));
    await finger.slide(chip, 8, 16);
    await page.waitForTimeout(SETTLE_MS);
    await finger.slide({ x: chip.x + 30, y: chip.y }, 6, 16);
    await page.waitForTimeout(350);
    const mid = await sheetState(page);
    await frame(page, info, `stow-${size}-2-mid-drag-${browserName}`);
    await finger.up();
    await page.waitForTimeout(900);
    const released = await sheetState(page);
    await frame(page, info, `stow-${size}-3-released-${browserName}`);

    // The selected trim's own handle, dragged directly (select first, then
    // drag). Synthetic pointers cannot be captured, so WebKit records only.
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
    expect(row.midChipDrag.stowed).toBe(true);
    expect(row.released).toMatchObject({ stowed: false, title: "Trim start" });
    expect(row.released.value).not.toBe(row.opened.value);
    if (browserName === "chromium") expect(row.midHandleDrag.stowed).toBe(true);
  });
}

for (const size of ["portrait-360", "landscape-844"] as const) {
  test(`Expand is remembered for the next selection, and so is Collapse: ${size}`, async ({
    page,
    context,
    browserName,
  }, info) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await buildFixture(page, projectPath, CLIENT_ID);
    const finger = await newFinger(context, page, browserName);
    await open(page, size);
    const tap = async (at: Point) => {
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await page.waitForTimeout(700);
    };
    const tapPoint = async (id: string) =>
      tap(
        await centerOf(
          page,
          `${lane} [data-hit-kind="envelope-point"][data-hit-id="${id}"]`,
        ),
      );
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
    await step(
      "one tap on Expand",
      await tapButton("Expand to the full inspector"),
    );
    await tapPoint("env-a");
    await step("next selection opens expanded");
    await step("collapse", await tapButton("Collapse to the strip"));
    await tapPoint("env-c");
    await step("next selection opens the strip");
    json(info, `remember-${size}-${browserName}`, steps);
    expect(
      steps.map((s) => [s.size, s.pref, s.buttonUnderFinger ?? null]),
    ).toEqual([
      ["peek", "strip", null],
      ["half", "inspector", "Expand to the full inspector"],
      ["half", "inspector", null],
      ["peek", "strip", "Collapse to the strip"],
      ["peek", "strip", null],
    ]);
  });
}

test("axe, both themes and reduced motion with the strip open", async ({
  page,
  context,
  browserName,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const finger = await newFinger(context, page, browserName);
  const rows: Record<string, unknown>[] = [];
  for (const motion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion: motion });
    for (const theme of ["dark", "light"] as const) {
      await open(page, "portrait-360", { theme });
      await holdOpen(page, finger);
      await finger.slide(await centerOfBox(trimChip(page)), 8, 16);
      await page.waitForTimeout(SETTLE_MS);
      await finger.up();
      await page.waitForTimeout(700);
      const axeStrip = await new AxeBuilder({ page })
        .disableRules([...STUDIO_AXE_DISABLED_RULES])
        .include(".bottom-sheet")
        .analyze();
      await frame(page, info, `strip-${theme}-${motion}-${browserName}`);
      const transition = await sheet(page).evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      );
      const nudges = await page
        .locator(".inspector-peek-nudge")
        .evaluateAll((els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return {
              label: e.getAttribute("aria-label"),
              w: Math.round(r.width),
              h: Math.round(r.height),
            };
          }),
        );
      await page
        .getByRole("button", { name: "Expand to the full inspector" })
        .click();
      await page.waitForTimeout(600);
      const axeExpanded = await new AxeBuilder({ page })
        .disableRules([...STUDIO_AXE_DISABLED_RULES])
        .include(".bottom-sheet")
        .analyze();
      rows.push({
        motion,
        theme,
        transition,
        nudges,
        axeStrip: axeStrip.violations.map((v) => v.id),
        axeExpanded: axeExpanded.violations.map((v) => v.id),
      });
    }
  }
  json(info, `axe-theme-motion-${browserName}`, rows);
  for (const row of rows as {
    motion: string;
    transition: string;
    nudges: { label: string; w: number; h: number }[];
    axeStrip: string[];
    axeExpanded: string[];
  }[]) {
    expect(row.axeStrip).toEqual([]);
    expect(row.axeExpanded).toEqual([]);
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
