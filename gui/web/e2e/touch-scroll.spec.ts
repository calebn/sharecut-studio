import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";
import {
  buildFixture,
  centerOf,
  json,
  lane,
  newTouchPage,
  openTimeline,
  type Point,
  pickState,
  save,
  setZoom,
  touchDrag,
  VIEWPORTS,
  type ViewportName,
  watchCommands,
} from "./touchTimeline";

/*
 * #1051 finding 2: a finger dragged across the timeline to scroll must
 * scroll it and never select, open or edit what it started on. CDP touch
 * drags from each kind of target at a phone and a tablet size. The spec also
 * runs against an older build (PODCAST_GUI_DIST) with TOUCH_SCROLL_RUN naming
 * the run, so the before/after evidence comes from the same code.
 */

const CLIENT_ID = "e2e-touch-scroll";
const RUN = process.env.TOUCH_SCROLL_RUN ?? "after";
const LAB = process.env.TOUCH_SCROLL_LAB ?? "touch-chooser";

test.use({ hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 600_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-scroll-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

/** Where each drag starts; selectors hold on builds without hit markers. */
const STARTS: Record<string, (page: Page) => Promise<Point | null>> = {
  "clip body": async (page) => {
    const box = await page.evaluate((laneSel) => {
      const clip = [
        ...document.querySelectorAll(`${laneSel} .clip-block`),
      ].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 80 && r.left > 40 && r.right < innerWidth - 40;
      });
      clip?.scrollIntoView({ block: "center", inline: "nearest" });
      const r = clip?.getBoundingClientRect();
      return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    }, lane);
    return box ? { x: box.x + box.w / 2, y: box.y + box.h * 0.75 } : null;
  },
  "lone envelope point": (page) =>
    centerOf(page, `${lane} circle[aria-label^="Envelope point 3 "]`),
  "crowded envelope point": (page) =>
    centerOf(page, `${lane} circle[aria-label^="Envelope point 2 "]`),
  "join badge": (page) => centerOf(page, `${lane} .join-badge >> nth=-1`),
  "pending region": (page) =>
    centerOf(page, `${lane} .pending-overlay .pending-hit`),
  "fade corner": (page) => centerOf(page, `${lane} .fade-corner.in`),
};

/** Finger travel toward the side the timeline can still scroll to. */
async function dragDelta(page: Page): Promise<Point> {
  const room = await page
    .locator(".timeline-scroll")
    .first()
    .evaluate((el) => ({
      left: el.scrollLeft,
      right: el.scrollWidth - el.clientWidth - el.scrollLeft,
    }));
  return { x: room.right >= room.left ? -120 : 120, y: 0 };
}

async function scrollOffset(page: Page): Promise<Point> {
  return page
    .locator(".timeline-scroll")
    .first()
    .evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
}

test("dragging to scroll scrolls and activates nothing", async ({
  page,
  context,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const rows: Record<string, unknown>[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    for (const [start, locate] of Object.entries(STARTS)) {
      const { page: p, cdp } = await newTouchPage(context);
      const commands = watchCommands(p);
      await openTimeline(p, projectPath, viewport, "dark", LAB || null);
      await setZoom(p, 3);
      const at = await locate(p);
      if (!at) {
        rows.push({ viewport, start, skipped: "not on screen" });
        await p.close();
        continue;
      }
      const before = await pickState(p);
      const scrollBefore = await scrollOffset(p);
      commands.length = 0;
      await touchDrag(cdp, p, at, await dragDelta(p));
      await p.waitForTimeout(600);
      const after = await pickState(p);
      const scrollAfter = await scrollOffset(p);
      const changed = Object.fromEntries(
        Object.entries(after).filter(
          ([key, value]) =>
            JSON.stringify(value) !==
            JSON.stringify(before[key as keyof typeof before]),
        ),
      );
      rows.push({
        viewport,
        start,
        at,
        scrolledPx: Math.round(Math.abs(scrollAfter.x - scrollBefore.x)),
        commands: commands.map((c) => c.type),
        changed,
      });
      await p.close();
    }
  }
  json(info, `drag-to-scroll-${RUN}`, rows);
  const ran = rows.filter((r) => !r.skipped);
  expect(ran.length).toBeGreaterThan(6);
  expect(ran.filter((r) => (r.scrolledPx as number) < 60)).toEqual([]);
  expect(
    ran.filter(
      (r) =>
        (r.commands as string[]).length > 0 ||
        Object.keys(r.changed as object).length > 0,
    ),
  ).toEqual([]);
});

test("a tap still selects or opens what it lands on", async ({
  page,
  context,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const rows: Record<string, unknown>[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    for (const start of ["clip body", "lone envelope point", "join badge"]) {
      const { page: p, cdp } = await newTouchPage(context);
      await openTimeline(p, projectPath, viewport, "dark", LAB || null);
      await setZoom(p, 3);
      const at = await STARTS[start](p);
      if (!at) throw new Error(`${start} not on screen`);
      await touchDrag(cdp, p, at, { x: 0, y: 0 }, { steps: 1, stepMs: 60 });
      await p.waitForTimeout(600);
      const after = await pickState(p);
      rows.push({
        viewport,
        start,
        activated:
          start === "clip body"
            ? after.selectedClips.length === 1
            : start === "join badge"
              ? after.openJoin != null
              : after.pressedPoint?.startsWith("Envelope point 3 ") === true,
        after,
      });
      await p.close();
    }
  }
  json(info, `tap-${RUN}`, rows);
  expect(rows.filter((r) => !r.activated)).toEqual([]);
});

test("video: drag to scroll from a clip and a crowded point", async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: VIEWPORTS.phone,
    recordVideo: { dir: info.outputPath("video"), size: VIEWPORTS.phone },
  });
  const { page, cdp } = await newTouchPage(context);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await openTimeline(page, projectPath, "phone", "dark", LAB || null);
  await setZoom(page, 3);
  for (const start of ["clip body", "crowded envelope point"]) {
    const at = await STARTS[start](page);
    if (!at) continue;
    await page.waitForTimeout(700);
    await touchDrag(cdp, page, at, await dragDelta(page), {
      steps: 20,
      stepMs: 30,
    });
    await page.waitForTimeout(1200);
  }
  const video = page.video();
  await context.close();
  if (video) {
    save(
      info,
      `drag-to-scroll-${RUN}.webm`,
      fs.readFileSync(await video.path()),
    );
  }
});

/** Counts text selection and context-menu events on the page. */
async function watchSelection(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { selectionLog: Record<string, number> };
    w.selectionLog = { selectstart: 0, contextmenu: 0, contextmenuShown: 0 };
    document.addEventListener("selectstart", () => {
      w.selectionLog.selectstart += 1;
    });
    document.addEventListener("contextmenu", (e) => {
      w.selectionLog.contextmenu += 1;
      // Target listeners run first; an unprevented event would open a menu.
      setTimeout(() => {
        if (!e.defaultPrevented) w.selectionLog.contextmenuShown += 1;
      });
    });
  });
}

test("a held, sliding finger starts no text selection or callout", async ({
  page,
  context,
}, info) => {
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const rows: Record<string, unknown>[] = [];
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    const { page: p, cdp } = await newTouchPage(context);
    await openTimeline(p, projectPath, viewport, "dark", LAB || null);
    await setZoom(p, 3);
    const at = await centerOf(p, `${lane} .clip-label`);
    await watchSelection(p);
    await touchDrag(cdp, p, at, { x: 60, y: 0 }, { holdMs: 900 });
    await p.waitForTimeout(400);
    rows.push({
      viewport,
      style: await p
        .locator(`${lane} .clip-label`)
        .first()
        .evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            userSelect: s.userSelect || s.webkitUserSelect,
            touchCallout:
              s.getPropertyValue("-webkit-touch-callout") || "(unsupported)",
          };
        }),
      events: await p.evaluate(
        () =>
          (window as unknown as { selectionLog: Record<string, number> })
            .selectionLog,
      ),
      selection: await p.evaluate(() => document.getSelection()?.toString()),
    });
    await p.close();
  }
  json(info, `selection-${RUN}`, rows);
  for (const row of rows) {
    expect(row).toMatchObject({
      style: { userSelect: "none" },
      events: { selectstart: 0, contextmenuShown: 0 },
      selection: "",
    });
  }
});
