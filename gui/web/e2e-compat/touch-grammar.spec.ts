import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "../e2e/axe";
import { postDocumentCommand } from "../e2e/documentCommand";
import { e2eProjectPath } from "../e2e/env";
import { type Finger, newFinger, type Point, twoFingers } from "../e2e/finger";
import { layer } from "../e2e/lifecycleAudit";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import {
  closeTools,
  inspectSelection,
  openProject,
  openToolsIfFolded,
} from "../e2e/stageNav";
import { ownsStudioAxe } from "../e2e/studioAxeOwnership";
import { setTheme } from "../e2e/theme";
import {
  buildFixture,
  centerOf,
  json,
  lane,
  projectJson,
  save,
  setZoom,
  TRACK,
  visiblePoint,
  watchCommands,
} from "../e2e/touchTimeline";
import { CHOOSER_EDGE_PX } from "../src/stages/edit/chooserMath";
import { TOUCH_HIT_RADIUS_PX } from "../src/timeline/hitCandidates";

/*
 * #1051 round 4b, the touch grammar on a 430x932 iPhone viewport: a
 * long-press arms a target and only it drags, along its own axes (a clip
 * body moves in time); a long-press on empty space opens the create menu; an
 * armed drag detents at a soft boundary; the drawer swipes between its
 * detents; a second finger cancels it all. #1135: a long-press at a join offers the ripple
 * trim, whose drag keeps the edge under the finger and shows how far later
 * clips will move on every dialogue lane. Chromium drives CDP touch, WebKit touch-typed pointer
 * events (e2e/finger.ts). Frames go to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-touch-grammar";
const IPHONE = { width: 430, height: 932 };

/** The create menu: a menu, or on the phone shell a bottom Sheet. */
const createMenu = (page: Page) =>
  page
    .getByRole("menu", { name: /^Create at / })
    .or(page.getByRole("dialog", { name: /^Create at / }));
/** Past the 500 ms long-press, with room for the press layer's timer. */
const HOLD_MS = 750;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 300_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-touch-grammar-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

type Saved = {
  envelopes: {
    track_id: string;
    points: { id: string; time: number; value: number }[];
  }[];
};

async function saved(page: Page): Promise<Saved> {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  return (await res.json()) as Saved;
}

const points = async (page: Page) =>
  (await saved(page)).envelopes.find((e) => e.track_id === TRACK)?.points ?? [];

/** The guest lane after `open`: a clip from 0 to 20 s, a gap, and one from 30 s. */
type GuestLane = { trackId: string; movedId: string };

async function splitGuestLane(page: Page): Promise<GuestLane> {
  const run = (type: string, payload: Record<string, unknown>) =>
    postDocumentCommand(page, CLIENT_ID, type, payload, projectPath);
  const tracks = (await projectJson(page, projectPath)).clips.tracks;
  const trackId = Object.keys(tracks).find((id) => id !== TRACK);
  if (!trackId) throw new Error("no guest track");
  await run("SplitAtTime", { at_time: 20, track_ids: [trackId] });
  const right = (await projectJson(page, projectPath)).clips.tracks[
    trackId
  ].find((c) => c.timeline_start === 20);
  if (!right) throw new Error("split at 20 s missing");
  await run("MoveClips", {
    clips: [{ clip_id: right.id, timeline_start: 30, track_id: trackId }],
  });
  return { trackId, movedId: right.id };
}

/** Opens the fixture on the phone timeline, after `setup` edits the project. */
async function openWith<T>(
  page: Page,
  setup: () => Promise<T>,
  size: { width: number; height: number } = IPHONE,
): Promise<T> {
  await page.setViewportSize(size);
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const made = await setup();
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  if (size.width < 768) await openPhoneTimeline(page);
  await layer(page, "Volume envelope", true);
  await setTheme(page, "dark");
  await setZoom(page, 3);
  return made;
}

const open = (page: Page) => openWith(page, async () => undefined);

const openWithGap = (page: Page) => openWith(page, () => splitGuestLane(page));

async function expectBelowEnvelopeLine(page: Page, trackId: string, y: number) {
  // The line is a zero-height path with no Playwright box; its strip is wider than it.
  const line = await page
    .locator(`.lane-row[data-track-id="${trackId}"] .sys-env-line`)
    .evaluate((path) => {
      const box = path.getBoundingClientRect();
      return { y: box.y, height: box.height };
    });
  expect(y).toBeGreaterThan(line.y + line.height + TOUCH_HIT_RADIUS_PX);
}

async function expectClipAt(page: Page, selector: string, at: Point) {
  expect(
    await page
      .locator(`${selector} .clip-hit`)
      .evaluate(
        (clip, point) =>
          document
            .elementFromPoint(point.x, point.y)
            ?.closest("[data-hit-kind]") === clip,
        at,
      ),
  ).toBe(true);
}

async function expectEmptyAt(page: Page, at: Point) {
  const hit = await page.evaluate((point) => {
    const element = document.elementFromPoint(point.x, point.y);
    return {
      kind:
        element?.closest("[data-hit-kind]")?.getAttribute("data-hit-kind") ??
        null,
      surface: Boolean(element?.closest("[data-hit-surface]")),
      element: element?.outerHTML.slice(0, 300),
    };
  }, at);
  expect(hit.kind).toBeNull();
  expect(hit.surface, hit.element).toBe(true);
}

/**
 * Lays the guest lane's gap out in the time column, the moved clip's start
 * (30 s) left of the fixed playhead, so a drag left meets the neighbour's end
 * (20 s) before the playhead. Returns the clip, the zoom and where it starts.
 */
async function showGap(page: Page, guest: GuestLane) {
  const clip = `.lane-row[data-track-id="${guest.trackId}"] .clip-block[data-clip-id="${guest.movedId}"]`;
  for (const steps of [3, 2, 1, 0]) {
    await setZoom(page, steps);
    const layout = await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
      if (!el || !scroller) return null;
      const view = scroller.getBoundingClientRect();
      const left =
        scroller.querySelector(".track-headers")?.getBoundingClientRect()
          .right ?? view.left;
      const right = view.left + scroller.clientWidth;
      const box = el.getBoundingClientRect();
      const pps = box.width / 40;
      scroller.scrollLeft +=
        box.left - (left + (right - left) * 0.1 + 10 * pps);
      return { pps, center: (left + right) / 2 };
    }, clip);
    if (!layout) throw new Error("guest clip not found");
    await page.waitForTimeout(300);
    const box = await page.locator(clip).boundingBox();
    if (!box) throw new Error("guest clip has no box");
    if (box.x + 40 < layout.center) {
      const y = box.y + box.height - 8;
      await expectBelowEnvelopeLine(page, guest.trackId, y);
      return {
        clip,
        pps: layout.pps,
        start: box.x,
        y,
      };
    }
  }
  throw new Error("no zoom shows the gap left of the playhead");
}

async function frame(page: Page, info: TestInfo, name: string) {
  save(info, `${name}.png`, await page.screenshot());
}

async function hold(page: Page, finger: Finger, at: Point) {
  await finger.down(at);
  await page.waitForTimeout(HOLD_MS);
}

async function tap(page: Page, finger: Finger, at: Point) {
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(600);
}

const envC = `${lane} [data-hit-id="env-c"]`;
const armed = (page: Page) => page.locator("[data-hit-armed]");

test("one finger moving never edits; a long-press arms, and the armed point drags in time and level", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const at = await centerOf(page, envC);
  // Selected, then dragged by one finger: no edit.
  await tap(page, finger, at);
  await finger.down(at);
  await finger.slide({ x: at.x + 80, y: at.y - 30 });
  await finger.up();
  await page.waitForTimeout(600);
  const afterScroll = commands.map((c) => c.type);

  const from = await centerOf(page, envC);
  await hold(page, finger, from);
  await expect(armed(page)).toHaveCount(1);
  await frame(page, info, `grammar-arm-held-${browserName}`);
  // The drag locks to one axis once it is past a few px: along time first.
  await finger.slide({ x: from.x + 24, y: from.y }, 8, 16);
  await frame(page, info, `grammar-arm-dragging-${browserName}`);
  await finger.up();
  await expect(armed(page)).toHaveCount(0);
  // The saved point, once the save lands: later in time, level untouched.
  await expect
    .poll(async () => (await points(page)).find((p) => p.id === "env-c")?.time)
    .toBeGreaterThan(16);
  const moved = (await points(page)).find((p) => p.id === "env-c");
  expect(moved?.value).toBe(1);
  // A second long press drags it along level.
  const next = await centerOf(page, envC);
  await hold(page, finger, next);
  await expect(armed(page)).toHaveCount(1);
  await finger.slide({ x: next.x, y: next.y - 30 }, 8, 16);
  await finger.up();
  await expect(armed(page)).toHaveCount(0);
  await expect
    .poll(async () => (await points(page)).find((p) => p.id === "env-c")?.value)
    .toBeGreaterThan(1);
  const point = (await points(page)).find((p) => p.id === "env-c");
  json(info, `grammar-arm-${browserName}`, {
    afterScroll,
    point,
    commands: commands.map((c) => c.type),
  });
  expect(afterScroll).toEqual([]);
  expect(commands.filter((c) => c.type === "SetEnvelope")).toHaveLength(2);
  expect(point?.time).toBe(moved?.time);
});

test("at 390x844 by default, one finger dragging a selected clip's trim end saves nothing and opens the drawer at half height", async ({
  page,
  context,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await openPhoneTimeline(page);
  await setTheme(page, "dark");
  await setZoom(page, 3);
  type Edge = { id: string; timeline_start: number; source_end: number };
  const clipAt50 = async () =>
    ((await projectJson(page, projectPath)).clips.tracks[TRACK] as Edge[]).find(
      (c) => c.timeline_start === 50,
    );
  const before = await clipAt50();
  if (!before) throw new Error("no clip at 50 s");
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  await tap(
    page,
    finger,
    await centerOf(page, `${lane} .clip-block[data-clip-id="${before.id}"]`),
  );
  const handle = await centerOf(
    page,
    `${lane} [data-hit-kind="trim-out"][data-hit-id="${before.id}"]`,
  );
  await finger.down(handle);
  await finger.slide({ x: handle.x - 30, y: handle.y }, 8, 20);
  await finger.up();
  await page.waitForTimeout(900);
  await inspectSelection(page);
  await frame(page, info, `grammar-default-trim-drag-${browserName}`);
  const row = {
    commands: commands.map((c) => c.type),
    sourceEnd: (await clipAt50())?.source_end,
    drawer: await page
      .locator('.sys-inspector--phone[data-detent="half"]')
      .count(),
    sheets: await page.locator(".sys-inspector--phone").count(),
  };
  json(info, `grammar-default-trim-drag-${browserName}`, row);
  expect(row).toEqual({
    commands: [],
    sourceEnd: before.source_end,
    drawer: 1,
    sheets: 1,
  });
});

type ClipMove = { clip_id: string; timeline_start: number; track_id: string };

/** On the moved clip's body, clear of its edge handles' 22 px finger reach. */
const onBody = (gap: { start: number; y: number }) => ({
  x: gap.start + 80,
  y: gap.y,
});

const clipStart = async (page: Page, guest: GuestLane) =>
  (await projectJson(page, projectPath)).clips.tracks[guest.trackId].find(
    (c) => c.id === guest.movedId,
  )?.timeline_start;

test("a long-press arms a clip, which moves in time only, holds at its neighbour's edge and saves there", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWithGap(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const gap = await showGap(page, guest);
  const from = onBody(gap);
  await expectClipAt(page, gap.clip, from);
  await hold(page, finger, from);
  await expect(page.locator(`${gap.clip} .clip-hit`)).toHaveAttribute(
    "data-hit-armed",
    "",
  );
  await expect(createMenu(page)).toHaveCount(0);
  await frame(page, info, `clip-move-armed-${browserName}`);
  // Left until the clip's start passes the neighbour's end (20 s) by less
  // than the detent, the finger drifting down: the clip stays in its lane.
  const neighbourEnd = gap.start - 10 * gap.pps;
  await finger.slide({ x: from.x - 10 * gap.pps - 8, y: from.y + 24 }, 16, 24);
  await expect(page.locator(".detent-mark-caption")).toHaveText(
    "At a clip edge",
  );
  const mark = await page.locator(".detent-mark").boundingBox();
  await frame(page, info, `clip-move-detent-${browserName}`);
  await finger.up();
  await expect(armed(page)).toHaveCount(0);
  await expect
    .poll(() => commands.filter((c) => c.type === "MoveClips").length)
    .toBe(1);
  await expect.poll(() => clipStart(page, guest)).toBeCloseTo(20, 3);
  await page.waitForTimeout(400);
  await frame(page, info, `clip-move-saved-${browserName}`);
  const moves = (commands.find((c) => c.type === "MoveClips")?.payload.clips ??
    []) as ClipMove[];
  json(info, `clip-move-${browserName}`, {
    pps: gap.pps,
    neighbourEnd,
    mark,
    moves,
    commands: commands.map((c) => c.type),
  });
  expect(moves).toHaveLength(1);
  expect(moves[0].clip_id).toBe(guest.movedId);
  expect(moves[0].track_id).toBe(guest.trackId);
  expect(moves[0].timeline_start).toBeCloseTo(20, 3);
  expect(Math.abs((mark?.x ?? 0) - neighbourEnd)).toBeLessThan(4);
});

test("a second finger cancels an armed clip move", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWithGap(page);
  const commands = watchCommands(page);
  const gap = await showGap(page, guest);
  const fingers = await twoFingers(context, page, browserName);
  const from = onBody(gap);
  await expectClipAt(page, gap.clip, from);
  await fingers.down(from);
  await page.waitForTimeout(HOLD_MS);
  await expect(armed(page)).toHaveCount(1);
  await fingers.move({ x: from.x - 40, y: from.y });
  await expect(page.locator(`${gap.clip}.clip-moving`)).toHaveCount(1);
  await frame(page, info, `clip-move-before-second-finger-${browserName}`);
  await fingers.join(
    { x: from.x - 40, y: from.y },
    { x: from.x + 80, y: from.y - 40 },
  );
  await fingers.both(
    { x: from.x - 60, y: from.y },
    { x: from.x + 110, y: from.y - 40 },
  );
  await frame(page, info, `clip-move-second-finger-${browserName}`);
  await fingers.up();
  await page.waitForTimeout(600);
  const armedAfter = await armed(page).count();
  const start = await clipStart(page, guest);
  json(info, `clip-move-second-finger-${browserName}`, {
    commands: commands.map((c) => c.type),
    armedAfter,
    start,
  });
  expect(commands.filter((c) => c.type === "MoveClips")).toEqual([]);
  expect(armedAfter).toBe(0);
  expect(start).toBe(30);
});

test("a long-press on empty space opens the create menu; Add volume point adds one there", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWithGap(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  // The gap in the guest's lane, which has no envelope points or pending edits.
  const gap = await showGap(page, guest);
  const at = { x: gap.start - 5 * gap.pps, y: gap.y };
  await expectEmptyAt(page, at);
  await hold(page, finger, at);
  await finger.up();
  // The phone shell shows the create menu as a bottom Sheet of buttons.
  const menu = page.getByRole("dialog", { name: /^Create at / });
  await expect(menu).toBeVisible();
  await frame(page, info, `grammar-create-menu-${browserName}`);
  const axe = ownsStudioAxe({ suite: "compat", engine: browserName })
    ? await new AxeBuilder({ page })
        .disableRules([...STUDIO_AXE_DISABLED_RULES])
        .include(".bottom-sheet")
        .analyze()
    : undefined;
  const items = await menu
    .locator(".sys-row-btn")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim()));
  await tap(
    page,
    finger,
    await centerOfLocator(
      menu.getByRole("button", { name: "Add volume point" }),
    ),
  );
  await expect
    .poll(() => commands.filter((c) => c.type === "SetEnvelope").length)
    .toBe(1);
  // The toast rests above the row that was pressed, which is where the
  // selection bar's grip is.
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await inspectSelection(page);
  await expect(
    page.getByRole("spinbutton", { name: "Level", exact: true }),
  ).toBeVisible();
  await frame(page, info, `grammar-create-added-${browserName}`);
  json(info, `grammar-create-${browserName}`, {
    items,
    ...(axe ? { axe: axe.violations.map((v) => v.id) } : {}),
    commands: commands.map((c) => ({ type: c.type, payload: c.payload })),
  });
  if (ownsStudioAxe({ suite: "compat", engine: browserName })) {
    expect(axe?.violations).toEqual([]);
  }
  expect(items).toEqual([
    "Split here",
    "Comment here",
    "Add chapter here",
    "Record here",
    "Add volume point",
  ]);
  const added = commands.find((c) => c.type === "SetEnvelope")?.payload as
    | { track_id: string; points: unknown[] }
    | undefined;
  expect(added?.track_id).toBe(guest.trackId);
  expect(added?.points).toHaveLength(3);
  const flat = added!.points as { id: string; time: number; value: number }[];
  const newPoint = flat.find((point) => point.time > 0 && point.time < 70);
  expect(flat[0]).toMatchObject({ time: 0, value: 1 });
  expect(flat[2]).toMatchObject({ time: 70, value: 1 });
  expect(newPoint).toMatchObject({ value: 1 });
  expect(new Set(flat.map((point) => point.id)).size).toBe(3);
  await expect
    .poll(
      async () =>
        (await saved(page)).envelopes.find(
          (env) => env.track_id === guest.trackId,
        )?.points,
    )
    .toEqual(flat);
});

test("a long-press past the last clip opens the create menu and selects no text", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  // The session's end under the fixed line: right of it is the trailing pad.
  const pad = await page.evaluate((selector) => {
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
    const canvas = document.querySelector(".timeline-hit-root");
    const row = document.querySelector(selector);
    if (!scroller || !canvas || !row) return null;
    scroller.scrollLeft = scroller.scrollWidth;
    const end = canvas.getBoundingClientRect().right;
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return {
      x: Math.round((end + view.left + scroller.clientWidth) / 2),
      y: Math.round(box.top + box.height / 2),
      end,
    };
  }, lane);
  if (!pad) throw new Error("no timeline");
  expect(pad.x).toBeGreaterThan(pad.end + 20);
  const userSelect = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const style = el ? getComputedStyle(el) : null;
    return style?.webkitUserSelect || style?.userSelect;
  }, pad);
  expect.soft(userSelect).toBe("none");
  await hold(page, finger, pad);
  await finger.up();
  // The lane's create menu, at the session's end (the fixture is 60 s).
  await expect(
    page.getByRole("dialog", { name: "Create at 01:00.000 · reference" }),
  ).toBeVisible();
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  await frame(page, info, `grammar-create-past-end-${browserName}`);
  json(info, `grammar-create-past-end-${browserName}`, {
    pad,
    userSelect,
    selected,
  });
  expect(selected).toBe("");
});

test("in a short viewport the create menu stays in view off the finger, and lifting without moving saves nothing", async ({
  page,
  context,
  browserName,
}, info) => {
  const landscape = { width: 844, height: 390 };
  const guest = await openWith(page, () => splitGuestLane(page), landscape);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const gap = await showGap(page, guest);
  // The timeline box is short here: bring the guest's lane into it first.
  const y = await page.evaluate((trackId) => {
    const row = document.querySelector(`.lane-row[data-track-id="${trackId}"]`);
    row?.scrollIntoView({ block: "center" });
    const box = row?.getBoundingClientRect();
    return box ? box.bottom - 8 : null;
  }, guest.trackId);
  if (y === null) throw new Error("guest lane not found");
  await expectBelowEnvelopeLine(page, guest.trackId, y);
  await page.waitForTimeout(300);
  const at = { x: gap.start - 5 * gap.pps, y };
  await expectEmptyAt(page, at);
  await hold(page, finger, at);
  const menu = page.getByRole("menu", { name: /^Create at / });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error("the create menu has no box");
  const underFinger = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest(".edit-create-menu") != null,
    at,
  );
  await frame(page, info, `grammar-create-short-held-${browserName}`);
  await finger.up();
  await page.waitForTimeout(700);
  const stillOpen = await menu.isVisible();
  await frame(page, info, `grammar-create-short-lifted-${browserName}`);
  json(info, `grammar-create-short-${browserName}`, {
    at,
    box,
    underFinger,
    stillOpen,
    commands: commands.map((c) => c.type),
  });
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(landscape.width);
  expect(box.y + box.height).toBeLessThanOrEqual(landscape.height);
  expect(underFinger).toBe(false);
  expect(stillOpen).toBe(true);
  expect(commands.map((c) => c.type)).toEqual([]);
});

/** (root font px, viewport height) pairs where the menu is taller than the room beside a short screen. */
const MENU_SWEEP: [number, number][] = [
  [16, 390],
  [24, 390],
  [28, 390],
  [32, 390],
  [24, 340],
  [28, 340],
  [24, 320],
  [20, 300],
  [28, 360],
  [32, 420],
  [36, 480],
];

type MenuRow = {
  rootPx: number;
  height: number;
  /** The menu's painted height, and the height its items need. */
  boxHeight: number;
  naturalHeight: number;
  overflow: number;
  scrolls: boolean;
  touchAction: string;
  lastShown: number;
  lastHeight: number;
  inViewport: boolean;
  overFinger: boolean;
};

/** Holds a finger on the guest lane at `rootPx` text and a `height` px screen, and measures the create menu. */
async function measureCreateMenu(
  page: Page,
  finger: Finger,
  guest: GuestLane,
  rootPx: number,
  height: number,
  rightEdge = false,
): Promise<MenuRow | null> {
  await page.setViewportSize({ width: 844, height });
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(400);
  const gap = await showGap(page, guest);
  let x = gap.start - 5 * gap.pps;
  if (rightEdge) {
    x = await page.evaluate((gapX) => {
      const scroller = document.querySelector<HTMLElement>(".timeline-scroll")!;
      const view = scroller.getBoundingClientRect();
      const before = scroller.scrollLeft;
      scroller.scrollLeft += gapX - (view.left + scroller.clientWidth - 20);
      return gapX - (scroller.scrollLeft - before);
    }, x);
  }
  const y = await page.evaluate((trackId) => {
    const row = document.querySelector(`.lane-row[data-track-id="${trackId}"]`);
    const scroller = document.querySelector<HTMLElement>(".timeline-scroll");
    const before = row?.getBoundingClientRect();
    const view = scroller?.getBoundingClientRect();
    if (!row || !scroller || !before || !view) return null;
    const visibleBottom = view.top + scroller.clientHeight - 20;
    scroller.scrollTop += before.bottom - visibleBottom;
    const box = row.getBoundingClientRect();
    const ruler = document
      .querySelector(".timeline-ruler")
      ?.getBoundingClientRect();
    const top = Math.max(box.top, view.top, ruler?.bottom ?? view.top);
    const bottom = Math.min(box.bottom, visibleBottom);
    return bottom - top < 8 ? null : bottom - 8;
  }, guest.trackId);
  if (y === null) return null;
  // A tall lane puts its foot under the floating Edit corner.
  const clear = await page.evaluate(
    ({ x, from }) => {
      for (let at = from; at > from - 160; at -= 4) {
        const top = document.elementFromPoint(x, at);
        if (top?.closest("[data-hit-surface]")) return at;
      }
      return from;
    },
    { x, from: y },
  );
  await expectBelowEnvelopeLine(page, guest.trackId, clear);
  const at = { x, y: clear };
  await expectEmptyAt(page, at);
  await hold(page, finger, at);
  const measured = await page.evaluate(({ x, y: fy }) => {
    const menu = document.querySelector<HTMLElement>(".edit-create-menu");
    if (!menu) return null;
    const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const box = menu.getBoundingClientRect();
    const overflow = menu.scrollHeight - menu.clientHeight;
    const scrolls = menu.hasAttribute("data-scrolls");
    menu.scrollTop = menu.scrollHeight;
    const last = items[items.length - 1]?.getBoundingClientRect();
    const lastShown = last
      ? Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top)
      : 0;
    return {
      boxHeight: Math.round(box.height),
      naturalHeight:
        menu.scrollHeight + (menu.offsetHeight - menu.clientHeight),
      overflow,
      scrolls,
      touchAction: getComputedStyle(menu).touchAction,
      lastShown: Math.round(lastShown),
      lastHeight: last ? Math.round(last.height) : 0,
      inViewport:
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight,
      overFinger:
        x > box.left && x < box.right && fy > box.top && fy < box.bottom,
    };
  }, at);
  await finger.up();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  return measured ? { rootPx, height, ...measured } : null;
}

/** The menu clips an item, blocks its own scrolling, leaves the screen or covers the finger. */
function menuIsBad(row: MenuRow): boolean {
  const clipped = row.overflow > 1 && !row.scrolls;
  const touchBlocked =
    row.scrolls && row.touchAction.split(" ").includes("none");
  return (
    clipped ||
    touchBlocked ||
    row.lastShown < row.lastHeight - 1 ||
    !row.inViewport ||
    row.overFinger
  );
}

test("tablet landscape at 200% text still lets Zoom hit the ruler", async ({
  page,
}) => {
  await openWith(page, () => splitGuestLane(page), {
    width: 844,
    height: 390,
  });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    )
    .toBe("32px");
  await page
    .locator(".sys-ruler-body")
    .first()
    .click({ position: { x: 4, y: 4 }, timeout: 8_000 });
});

test("the create menu reaches every item and stays off the finger at every text size and screen height", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWith(page, () => splitGuestLane(page), {
    width: 844,
    height: 390,
  });
  const finger = await newFinger(context, page, browserName);
  const rows: MenuRow[] = [];
  for (const [rootPx, height] of MENU_SWEEP) {
    const row = await measureCreateMenu(page, finger, guest, rootPx, height);
    if (row) rows.push(row);
  }
  const bad = rows.filter(menuIsBad);
  json(info, `grammar-create-sweep-${browserName}`, { rows, bad });
  expect(rows.length).toBeGreaterThanOrEqual(6);
  expect(bad).toEqual([]);
});

test("a create menu taller than 90% of the screen, with room beside the finger, is not cut to 90%", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWith(page, () => splitGuestLane(page), {
    width: 844,
    height: 390,
  });
  // The stacked tablet gives the lower half to the Script; hide it so the
  // timeline has the whole body.
  const folded = await openToolsIfFolded(page);
  await page.getByRole("button", { name: "Show or hide Script" }).click();
  if (folded) await closeTools(page);
  await expect(page.locator(".edit-script")).toHaveCount(0);
  const finger = await newFinger(context, page, browserName);
  const rows: MenuRow[] = [];
  for (const rootPx of [24, 26, 28, 30, 32, 34, 36]) {
    const tall = await measureCreateMenu(
      page,
      finger,
      guest,
      rootPx,
      900,
      true,
    );
    if (!tall) throw new Error(`no create menu at ${rootPx}px text`);
    // A screen just tall enough for the whole menu and its edges. Where the
    // menu is then more than 90dvh, nothing needs to cap or scroll it, so the
    // shared drop-down cap must not.
    const height = Math.ceil(tall.naturalHeight) + 2 * CHOOSER_EDGE_PX + 4;
    if (tall.naturalHeight <= 0.9 * height) continue;
    const row = await measureCreateMenu(
      page,
      finger,
      guest,
      rootPx,
      height,
      true,
    );
    if (!row) throw new Error(`no create menu at ${rootPx}px on ${height}px`);
    rows.push(row);
  }
  json(info, `grammar-create-over-90dvh-${browserName}`, { rows });
  expect(rows.filter(menuIsBad)).toEqual([]);
  // Where the layout found room it left the menu uncapped, and it shows whole.
  const uncapped = rows.filter((row) => !row.scrolls);
  expect(uncapped.length).toBeGreaterThanOrEqual(2);
  for (const row of uncapped) {
    expect(row.boxHeight).toBeGreaterThanOrEqual(row.naturalHeight - 1);
  }
});

test("the sheet follows the finger on its grip; a flick opens or closes it, the arrow keys step it", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  await tap(page, finger, await centerOf(page, envC));
  await inspectSelection(page);
  const sheet = page.locator(".sys-inspector--phone");
  await expect(sheet).toHaveAttribute("data-detent", "half");
  await frame(page, info, `grammar-sheet-half-${browserName}`);
  const grip = page.getByRole("slider", { name: "Sheet height" });
  const grab = async () => {
    const box = await grip.boundingBox();
    if (!box) throw new Error("no grip");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  /** `dy` px in four moves `stepMs` apart, lifted at once. */
  const flick = async (dy: number, stepMs = 8) => {
    const at = await grab();
    await finger.flick(at, { x: at.x, y: at.y + dy }, 4, stepMs);
    await page.waitForTimeout(500);
  };
  await flick(-250, 60);
  await expect(sheet).toHaveAttribute("data-detent", "full");
  await frame(page, info, `grammar-sheet-flick-full-${browserName}`);
  await flick(150, 60);
  await expect(sheet).toHaveAttribute("data-detent", "half");
  await grip.focus();
  await page.keyboard.press("ArrowUp");
  await expect(sheet).toHaveAttribute("data-detent", "full");
  await expect(grip).toHaveAttribute("aria-valuetext", "Full height");
  await page.keyboard.press("ArrowDown");
  await expect(sheet).toHaveAttribute("data-detent", "half");
  await expect(grip).toHaveAttribute("aria-valuetext", "Half height");
  await page.keyboard.press("Home");
  await expect(sheet).toHaveAttribute("data-detent", "dock");
});

test("a second finger cancels an armed drag and the create menu", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWithGap(page);
  const commands = watchCommands(page);
  const fingers = await twoFingers(context, page, browserName);
  const from = await centerOf(page, envC);
  await fingers.down(from);
  await page.waitForTimeout(HOLD_MS);
  await expect(armed(page)).toHaveCount(1);
  await fingers.move({ x: from.x + 40, y: from.y });
  await fingers.join(
    { x: from.x + 40, y: from.y },
    { x: from.x - 60, y: from.y + 40 },
  );
  await fingers.both(
    { x: from.x + 60, y: from.y },
    { x: from.x - 90, y: from.y + 40 },
  );
  await frame(page, info, `grammar-second-finger-${browserName}`);
  await fingers.up();
  await page.waitForTimeout(600);
  const armedAfter = await armed(page).count();

  const gap = await showGap(page, guest);
  const body = { x: gap.start - 5 * gap.pps, y: gap.y };
  await expectEmptyAt(page, body);
  await fingers.down(body);
  await page.waitForTimeout(HOLD_MS);
  await expect(createMenu(page)).toBeVisible();
  await fingers.join(body, { x: body.x - 80, y: body.y + 30 });
  await fingers.up();
  await page.waitForTimeout(600);
  const menuAfter = await createMenu(page).count();
  json(info, `grammar-second-finger-${browserName}`, {
    commands: commands.map((c) => c.type),
    armedAfter,
    menuAfter,
  });
  expect(commands.filter((c) => c.type === "SetEnvelope")).toEqual([]);
  expect(armedAfter).toBe(0);
  expect(menuAfter).toBe(0);
});

test("#1135: a long-press at a join offers the ripple trim, which shows where later clips go", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  // The join at 40 s. Selecting the clip after it shows its trim strips, so
  // the Seam diamond and that clip's ripple trim crowd one spot.
  const seam = await centerOf(
    page,
    `${lane} .seam-mark .sys-seam-hit[data-hit-kind="roll"] >> nth=1`,
  );
  await tap(page, finger, { x: seam.x + 60, y: seam.y + 40 });
  const crowded = await centerOf(
    page,
    `${lane} .seam-mark .sys-seam-hit[data-hit-kind="roll"] >> nth=1`,
  );
  await hold(page, finger, crowded);
  const chooser = page.getByRole("menu", { name: "Targets here" });
  await expect(chooser).toBeVisible();
  const chips = await chooser
    .getByRole("menuitem")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  const trimChip = chooser.getByRole("menuitem", {
    name: /^Clip, Trim start at /,
  });
  const chip = await centerOfLocator(trimChip);
  await finger.slide(chip, 6, 30);
  await page.waitForTimeout(HOLD_MS);
  await expect(chooser).toBeVisible();
  // Resting never grabs; a slide along the axis that stays on the chip does,
  // and the drag then goes on past it.
  await finger.slide({ x: chip.x + 16, y: chip.y }, 4, 30);
  await finger.slide({ x: chip.x + 40, y: chip.y }, 4, 30);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await expect(page.locator(".clip-landing")).toBeVisible();
  await frame(page, info, `ripple-drag-${browserName}`);
  const arrows = await page.locator(".lane-inner > .ripple-arrow").count();
  const lanes = await rippleLanes(page);
  await finger.up();
  await expect
    .poll(() => commands.filter((c) => c.type === "TrimClipEdge").length)
    .toBe(1);
  await page.waitForTimeout(400);
  await frame(page, info, `ripple-landed-${browserName}`);
  json(info, `ripple-${browserName}`, {
    chips,
    arrows,
    lanes,
    commands: commands.map((c) => ({ type: c.type, payload: c.payload })),
  });
  expect(chips.some((label) => /^Seam, /.test(label ?? ""))).toBe(true);
  // The trimmed start sheds time on the reference lane: its later clip (50 s)
  // moves back by that much.
  const [moved] = lanes[TRACK].arrows;
  expect(moved.width).toBeGreaterThan(4);
  // The guest's dialogue lane ripples with it: it loses the same span from
  // 40 s, and the rest of its clip moves back by the same distance.
  const guestLane = lanes.guest;
  expect(guestLane.arrows).toHaveLength(1);
  expect(guestLane.cuts).toHaveLength(1);
  expect(Math.abs(guestLane.arrows[0].width - moved.width)).toBeLessThan(1.5);
  expect(Math.abs(guestLane.cuts[0].width - moved.width)).toBeLessThan(1.5);
  expect(
    Math.abs(guestLane.arrows[0].left - guestLane.cuts[0].left),
  ).toBeLessThan(1.5);
});

type Box = { left: number; width: number };

/** Each lane's ripple arrows and lost spans, as drawn. */
async function rippleLanes(
  page: Page,
): Promise<Record<string, { arrows: Box[]; cuts: Box[] }>> {
  return page.evaluate(() => {
    const boxes = (row: Element, selector: string) =>
      [...row.querySelectorAll(selector)].map((el) => {
        const box = el.getBoundingClientRect();
        return { left: box.left, width: box.width };
      });
    return Object.fromEntries(
      [...document.querySelectorAll(".lane-row")].map((row) => [
        row.getAttribute("data-track-id") ?? "",
        {
          arrows: boxes(row, ".lane-inner > .ripple-arrow"),
          cuts: boxes(row, ".lane-inner > .clip-trimmed-span"),
        },
      ]),
    );
  });
}

test("#1154: a touch ripple trim over the guest's speech applies as one manual trim", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const pps = await setZoom(page, 1);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const before = (await projectJson(page, projectPath)).clips.tracks;
  const seam = await centerOf(
    page,
    `${lane} .seam-mark .sys-seam-hit[data-hit-kind="roll"] >> nth=1`,
  );
  await tap(page, finger, { x: seam.x + 20, y: seam.y });
  const crowded = await centerOf(
    page,
    `${lane} .seam-mark .sys-seam-hit[data-hit-kind="roll"] >> nth=1`,
  );
  await hold(page, finger, crowded);
  const chooser = page.getByRole("menu", { name: "Targets here" });
  await expect(chooser).toBeVisible();
  const chip = await centerOfLocator(
    chooser.getByRole("menuitem", { name: /^Clip, Trim start at / }),
  );
  await finger.slide(chip, 6, 30);
  await page.waitForTimeout(HOLD_MS);
  // The reference clip from 40 s loses its first 6 s; the guest speaks from
  // 43.5 s, so the ripple cuts "antonia pointed up to the sky". A person's
  // trim is an explicit manual action, so it applies without asking.
  await finger.slide({ x: chip.x + 6 * pps, y: chip.y }, 12, 30);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await finger.up();
  const trims = () => commands.filter((c) => c.type === "TrimClipEdge");
  await expect.poll(() => trims().length).toBe(1);
  expect(trims()[0].payload.mode).toBe("ripple");
  expect(trims()[0].payload).not.toHaveProperty("confirm_cut_speech");
  await expect(
    page.getByRole("dialog", { name: "Cut guest's speech too?" }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      (await projectJson(page, projectPath)).clips.tracks[TRACK].map(
        (c) => c.timeline_start,
      ),
    )
    .not.toEqual(before[TRACK].map((c) => c.timeline_start));
  const after = (await projectJson(page, projectPath)).clips.tracks;
  const starts = after[TRACK].map((c) => c.timeline_start);
  await frame(page, info, `cut-speech-ripple-${browserName}`);
  json(info, `cut-speech-${browserName}`, {
    pps,
    starts,
    guest: after.guest.map((c) => c.timeline_start),
    commands: trims().map((c) => c.payload),
  });
  expect(starts).toHaveLength(4);
  expect(starts.slice(0, 3)).toEqual([0, 10, 40]);
  // The edge follows the finger: 6 steps of pps px is 6.0 to 6.7 s at this
  // zoom (the grab leaves from where the finger settled on the chip, a few px
  // off its centre), so the clip starts at 50 minus that (a paused playhead
  // near the edge can stop it a little earlier, so the bound does not depend on
  // where it is).
  expect(starts[3]).toBeGreaterThan(43);
  expect(starts[3]).toBeLessThan(50);
  expect(after.guest).not.toEqual(before.guest);
  expect(trims()).toHaveLength(1);
});

test("#1135: a plain mouse grab at a join rolls it, as on main", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  await openProject(page, projectPath);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await setZoom(page, 3);
  const commands = watchCommands(page);
  const seam = await centerOf(
    page,
    `${lane} .seam-mark .sys-seam-hit[data-hit-kind="roll"] >> nth=1`,
  );
  await page.mouse.move(seam.x, seam.y);
  await page.mouse.down();
  await page.mouse.move(seam.x + 15, seam.y, { steps: 5 });
  await page.mouse.move(seam.x + 30, seam.y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => commands.filter((c) => c.type !== "SetSelection").length)
    .toBeGreaterThan(0);
  const types = commands.map((c) => c.type);
  json(info, "join-mouse-grab", { types });
  expect(types).toContain("RollClipJoin");
  expect(types).not.toContain("TrimClipEdge");
});

async function centerOfLocator(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test("an armed drag holds at a soft boundary, and saves there", async ({
  page,
  context,
  browserName,
}) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const from = await centerOf(page, envC);
  const pending = await visiblePoint(page, `${lane} [data-pending-id]`, 0, 0.5);
  if (!pending) throw new Error("pending cut not in view");
  await hold(page, finger, from);
  await finger.slide({ x: pending.x + 6, y: from.y }, 12, 24);
  await expect(page.locator(".detent-mark")).toBeVisible();
  await expect(page.locator(".detent-mark-caption")).toHaveText(
    "At the pending remove",
  );
  await finger.up();
  await expect
    .poll(async () => (await points(page)).find((p) => p.id === "env-c")?.time)
    .toBeGreaterThan(19);
  const held = (await points(page)).find((p) => p.id === "env-c");
  expect(held?.time).toBeLessThanOrEqual(20.01);
});
