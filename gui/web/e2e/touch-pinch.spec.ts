import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { switchE2eProject } from "./shareableProject";
import {
  buildFixture,
  centerOf,
  json,
  lane,
  type Point,
  projectJson,
  setZoom,
  shot,
  touch,
  visiblePoint,
  watchCommands,
} from "./touchTimeline";

/*
 * #1051 round 4: pinch never edits. One finger starts a fade or trim drag
 * (or presses a clip body), a second finger lands and the two pinch apart.
 * The drag is cancelled with no document command, the selection is what it
 * was before the first finger, and the timeline zooms. CDP drives two real
 * touch points, so the browser's own touch events reach the pinch handler.
 * PINCH_RUN names the build the evidence comes from (before/after).
 */

const CLIENT_ID = "e2e-touch-pinch";
const RUN = process.env.PINCH_RUN ?? "after";

const SIZES = {
  "portrait-360": { width: 360, height: 800 },
  "landscape-844": { width: 844, height: 390 },
} as const;

// Lab off, a selection opens the half sheet over a sideways phone's lanes,
// so the lab-off run is portrait only.
const RUNS = [
  { lab: true, size: "portrait-360" },
  { lab: true, size: "landscape-844" },
  { lab: false, size: "portrait-360" },
] as const;

test.use({ hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 240_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-pinch-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

type Clip = {
  id: string;
  timeline_start: number;
  source_start: number;
  source_end: number;
  fade_in_ms: number;
  fade_out_ms: number;
};

async function clips(page: Page): Promise<Clip[]> {
  const project = (await projectJson(page, projectPath)) as unknown as {
    clips: { tracks: Record<string, Clip[]> };
  };
  return Object.values(project.clips.tracks).flat();
}

/** A point low on the clip's body, with its start scrolled into view. */
async function clipBody(page: Page, clip: Clip): Promise<Point> {
  await centerOf(page, `${lane} [data-clip-id="${clip.id}"] .fade-corner.in`);
  const at = await visiblePoint(
    page,
    `${lane} .clip-block[data-clip-id="${clip.id}"]`,
    0.6,
  );
  if (!at) throw new Error("clip body not on screen");
  return at;
}

/**
 * Where the first finger starts (on the clip that starts at `clipAt` s, which
 * is selected first when `select`), and how far it drags alone (px) before
 * the second finger lands. A clip body is pinched at once: there the press
 * itself selects (lab off) or waits (lab on).
 */
const STARTS: Record<
  string,
  {
    clipAt: number;
    select: boolean;
    dragPx: number;
    locate: (page: Page, clip: Clip) => Promise<Point>;
  }
> = {
  "fade corner": {
    clipAt: 10,
    select: true,
    dragPx: 30,
    locate: (page, clip) =>
      centerOf(page, `${lane} [data-clip-id="${clip.id}"] .fade-corner.in`),
  },
  "trim handle": {
    clipAt: 50,
    select: true,
    dragPx: -30,
    locate: (page, clip) =>
      centerOf(page, `${lane} [data-clip-id="${clip.id}"] .trim-handle.out`),
  },
  "clip body": {
    clipAt: 10,
    select: false,
    dragPx: 0,
    locate: clipBody,
  },
};

async function state(page: Page) {
  return page.evaluate(() => ({
    selected: [...document.querySelectorAll(".clip-block.selected")].map((el) =>
      el.getAttribute("data-clip-id"),
    ),
    preview:
      document.querySelector(
        ".clip-block.fade-dragging, .clip-block.trim-dragging, .clip-block.clip-moving",
      ) != null,
  }));
}

/** First finger drags `dragPx`, a second lands 90 px away, and both spread. */
async function dragThenPinch(
  cdp: CDPSession,
  page: Page,
  at: Point,
  dragPx: number,
  frame: (step: string) => Promise<void>,
) {
  await touch(cdp, "touchStart", [at]);
  await page.waitForTimeout(32);
  const one = { ...at };
  for (let k = 1; k <= 6 && dragPx !== 0; k += 1) {
    one.x = at.x + (dragPx * k) / 6;
    await touch(cdp, "touchMove", [one]);
    await page.waitForTimeout(16);
  }
  await frame("1-one-finger");
  const mid = await state(page);
  // The second finger lands on the roomier side; both then spread apart.
  const side = one.x < (page.viewportSize()?.width ?? 0) / 2 ? 1 : -1;
  const two = { x: one.x + 90 * side, y: one.y };
  await touch(cdp, "touchStart", [one, two]);
  await page.waitForTimeout(32);
  await frame("2-second-finger");
  for (let k = 1; k <= 10; k += 1) {
    await touch(cdp, "touchMove", [
      { x: one.x - 6 * k * side, y: one.y },
      { x: two.x + 6 * k * side, y: two.y },
    ]);
    await page.waitForTimeout(16);
  }
  await frame("3-pinched");
  await touch(cdp, "touchEnd", []);
  await page.waitForTimeout(700);
  await frame("4-released");
  return mid;
}

for (const { lab, size } of RUNS) {
  const viewport = SIZES[size];
  const name = `${size}-lab-${lab ? "on" : "off"}`;
  test(`a second finger cancels the drag and pinches (${name})`, async ({
    page,
    context,
  }, info) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await buildFixture(page, projectPath, CLIENT_ID);
    const rows: Record<string, unknown>[] = [];
    for (const [start, { clipAt, select, dragPx, locate }] of Object.entries(
      STARTS,
    )) {
      const p = await context.newPage();
      await p.setViewportSize(viewport);
      const cdp = await context.newCDPSession(p);
      await p.goto(
        `/?project=${encodeURIComponent(projectPath)}&lab=${lab ? "" : "-"}touch-chooser`,
      );
      await expect(p.locator(".daw-shell")).toBeVisible();
      if (viewport.width < 768) await openPhoneTimeline(p);
      await setZoom(p, 4);
      const clip = (await clips(p)).find((c) => c.timeline_start === clipAt);
      if (!clip) throw new Error(`clip at ${clipAt} s missing`);
      if (select) {
        await touch(cdp, "touchStart", [await clipBody(p, clip)]);
        await p.waitForTimeout(60);
        await touch(cdp, "touchEnd", []);
        await p.waitForTimeout(700);
      }
      const before = await state(p);
      const saved = (await clips(p)).find((c) => c.id === clip.id);
      const zoomBefore = await rulerWidthPx(p);
      const commands = watchCommands(p);
      const slug = `pinch-${RUN}-${name}-${start.replaceAll(" ", "-")}`;
      const mid = await dragThenPinch(
        cdp,
        p,
        await locate(p, clip),
        dragPx,
        (step) => shot(info, p, `${slug}-${step}`),
      );
      rows.push({
        start,
        before,
        mid,
        after: await state(p),
        commands: commands.map((c) => c.type),
        savedBefore: saved,
        savedAfter: (await clips(p)).find((c) => c.id === clip.id),
        zoomBefore: Math.round(zoomBefore),
        zoomAfter: Math.round(await rulerWidthPx(p)),
      });
      await p.close();
    }
    json(info, `pinch-${RUN}-${name}`, rows);
    for (const row of rows as {
      start: string;
      before: { selected: string[] };
      mid: { preview: boolean; selected: string[] };
      after: { selected: string[]; preview: boolean };
      commands: string[];
      savedBefore: Clip;
      savedAfter: Clip;
      zoomBefore: number;
      zoomAfter: number;
    }[]) {
      // The first finger really started a drag before the pinch.
      if (row.start !== "clip body") expect(row.mid.preview).toBe(true);
      expect(row.commands).toEqual([]);
      expect(row.savedAfter).toEqual(row.savedBefore);
      expect(row.after).toEqual({ ...row.before, preview: false });
      expect(row.zoomAfter).toBeGreaterThan(row.zoomBefore * 1.2);
    }
  });
}
