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
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
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

/*
 * #1051 round 4b, the touch grammar on a 430x932 iPhone viewport: a
 * long-press arms a target and only it drags, along its own axes (a clip
 * body moves in time); a long-press on empty space opens the create menu; an
 * armed drag detents at a soft boundary; the strip swipes between drawer
 * detents; a second finger cancels it all. #1135: a long-press at a join offers the ripple
 * trim, whose drag keeps the edge under the finger and shows how far later
 * clips will move on every dialogue lane. Chromium drives CDP touch, WebKit touch-typed pointer
 * events (e2e/finger.ts). Frames go to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-touch-grammar";
const IPHONE = { width: 430, height: 932 };
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
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const made = await setup();
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (size.width < 768) await openPhoneTimeline(page);
  await setTheme(page, "dark");
  await setZoom(page, 3);
  return made;
}

const open = (page: Page) => openWith(page, async () => undefined);

const openWithGap = (page: Page) => openWith(page, () => splitGuestLane(page));

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
      return {
        clip,
        pps: layout.pps,
        start: box.x,
        y: box.y + box.height / 2,
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
  await finger.slide({ x: from.x + 24, y: from.y - 12 });
  await frame(page, info, `grammar-arm-dragging-${browserName}`);
  await finger.up();
  await expect(armed(page)).toHaveCount(0);
  // The saved point, once the save lands: later in time, higher in level.
  await expect
    .poll(async () => (await points(page)).find((p) => p.id === "env-c")?.time)
    .toBeGreaterThan(16);
  const point = (await points(page)).find((p) => p.id === "env-c");
  json(info, `grammar-arm-${browserName}`, {
    afterScroll,
    point,
    commands: commands.map((c) => c.type),
  });
  expect(afterScroll).toEqual([]);
  expect(commands.filter((c) => c.type === "SetEnvelope")).toHaveLength(1);
  expect(point?.value).toBeGreaterThan(1);
});

test("at 390x844 by default, one finger dragging a selected clip's trim end saves nothing and opens the strip, not the half sheet", async ({
  page,
  context,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
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
  await frame(page, info, `grammar-default-trim-drag-${browserName}`);
  const row = {
    commands: commands.map((c) => c.type),
    sourceEnd: (await clipAt50())?.source_end,
    strip: await page.locator(".bottom-sheet--compact").count(),
    sheets: await page.locator(".bottom-sheet").count(),
  };
  json(info, `grammar-default-trim-drag-${browserName}`, row);
  expect(row).toEqual({
    commands: [],
    sourceEnd: before.source_end,
    strip: 1,
    sheets: 1,
  });
});

test("an armed drag holds at a soft boundary, and saves there", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const from = await centerOf(page, envC);
  // The pending remove starting at 20 s is a soft boundary on this track.
  const pending = await visiblePoint(page, `${lane} [data-pending-id]`, 0, 0.5);
  if (!pending) throw new Error("pending cut not in view");
  await hold(page, finger, from);
  await finger.slide({ x: pending.x + 6, y: from.y }, 12, 24);
  await expect(page.locator(".detent-mark")).toBeVisible();
  await expect(page.locator(".detent-mark-caption")).toHaveText(
    "At the pending remove",
  );
  await frame(page, info, `grammar-detent-${browserName}`);
  await finger.up();
  await expect
    .poll(async () => (await points(page)).find((p) => p.id === "env-c")?.time)
    .toBeCloseTo(20, 3);
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
  await hold(page, finger, from);
  await expect(page.locator(`${gap.clip} .clip-hit`)).toHaveAttribute(
    "data-hit-armed",
    "",
  );
  await expect(page.getByRole("menu", { name: /^Create at / })).toHaveCount(0);
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

test("a long-press on empty space opens the create menu; Add envelope point adds one there", async ({
  page,
  context,
  browserName,
}, info) => {
  const guest = await openWithGap(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  // The gap in the guest's lane, which has no envelope points or pending edits.
  const gap = await showGap(page, guest);
  await hold(page, finger, { x: gap.start - 5 * gap.pps, y: gap.y });
  await finger.up();
  const menu = page.getByRole("menu", { name: /^Create at / });
  await expect(menu).toBeVisible();
  await frame(page, info, `grammar-create-menu-${browserName}`);
  const axe = await new AxeBuilder({ page })
    .disableRules([...STUDIO_AXE_DISABLED_RULES])
    .include(".create-menu")
    .analyze();
  const items = await menu
    .getByRole("menuitem")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim()));
  await tap(
    page,
    finger,
    await centerOfLocator(
      menu.getByRole("menuitem", { name: /Add envelope point/ }),
    ),
  );
  await expect
    .poll(() => commands.filter((c) => c.type === "SetEnvelope").length)
    .toBe(1);
  await expect(page.locator(".nudge-row", { hasText: "Level" })).toBeVisible();
  await frame(page, info, `grammar-create-added-${browserName}`);
  json(info, `grammar-create-${browserName}`, {
    items,
    axe: axe.violations.map((v) => v.id),
    commands: commands.map((c) => ({ type: c.type, payload: c.payload })),
  });
  expect(axe.violations).toEqual([]);
  expect(items[0]).toMatch(/^Add envelope point/);
  expect(items.slice(1)).toEqual([
    "Blade cutCuts all dialogue tracks",
    "Add chapter",
    "Add comment",
  ]);
  const added = commands.find((c) => c.type === "SetEnvelope")?.payload as
    | { track_id: string; points: unknown[] }
    | undefined;
  expect(added?.track_id).toBe(guest.trackId);
  expect(added?.points).toHaveLength(1);
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
    page.getByRole("menu", { name: "Create at 01:00.000 · reference" }),
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
    return box ? box.top + box.height / 2 : null;
  }, guest.trackId);
  if (y === null) throw new Error("guest lane not found");
  await page.waitForTimeout(300);
  const at = { x: gap.start - 5 * gap.pps, y };
  await hold(page, finger, at);
  const menu = page.getByRole("menu", { name: /^Create at / });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error("the create menu has no box");
  const underFinger = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest(".create-menu") != null,
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

test("the strip follows the finger; a flick opens or closes it fully, a slow drag lands at the nearest detent", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  await tap(page, finger, await centerOf(page, envC));
  const sheet = page.locator(".bottom-sheet--compact");
  await expect(sheet).toHaveClass(/bottom-sheet--peek/);
  await frame(page, info, `grammar-drawer-peek-${browserName}`);
  const top = async () => {
    const box = await sheet.boundingBox();
    if (!box) throw new Error("no sheet");
    return box.y;
  };
  // The drawer's slot, and its half and full shares (bottom-sheet.css).
  const slot = await page.evaluate(() => {
    const root = document.querySelector(".bottom-sheet-root");
    if (!root) throw new Error("no drawer");
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const box = root.getBoundingClientRect();
    return {
      bottom: box.bottom,
      half: Math.max(
        Math.min(box.height / 2, 26.25 * rem, box.height - 13 * rem),
        Math.min(box.height, 9 * rem),
      ),
      full: Math.min(box.height, 56.25 * rem),
    };
  });
  const grab = async () => {
    const box = await page.locator(".bottom-sheet-grabber").boundingBox();
    if (!box) throw new Error("no grabber");
    return { x: box.x + box.width / 2 + 60, y: box.y + 4 };
  };
  /** `dy` px in four moves `stepMs` apart, lifted at once: 8 is a flick. */
  const flick = async (dy: number, stepMs = 8) => {
    const at = await grab();
    await finger.flick(at, { x: at.x, y: at.y + dy }, 4, stepMs);
    await page.waitForTimeout(500);
  };
  /** A slow drag by `dy`, held still, then lifted: where the top was and is held. */
  const drag = async (dy: number) => {
    const at = await grab();
    const before = await top();
    await finger.down(at);
    await finger.slide({ x: at.x, y: at.y + dy }, 15, 40);
    await page.waitForTimeout(300);
    const held = await top();
    await finger.up();
    await page.waitForTimeout(500);
    return { before, held };
  };

  await flick(-60);
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  await frame(page, info, `grammar-drawer-flick-full-${browserName}`);
  await flick(60);
  await expect(sheet).toHaveClass(/bottom-sheet--peek/);
  // The same 60px drawn out over 800 ms is a drag: the strip stays.
  await flick(-60, 200);
  await expect(sheet).toHaveClass(/bottom-sheet--peek/);

  // Up to the half detent's height and held there: it follows 1:1 and stays.
  const strip = slot.bottom - (await top());
  const toHalf = await drag(-(slot.half - strip));
  await expect(sheet).toHaveClass(/bottom-sheet--half/);
  await frame(page, info, `grammar-drawer-slow-half-${browserName}`);
  // Slowly up past the middle of half and full: full.
  const toFull = await drag(-0.7 * (slot.full - slot.half));
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  // Down a little and held: still full, not a detent lower.
  await drag(40);
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  json(info, `grammar-drawer-${browserName}`, { slot, strip, toHalf, toFull });
  expect(toHalf.before - toHalf.held).toBeCloseTo(slot.half - strip, -1);
  expect(toFull.before - toFull.held).toBeCloseTo(
    0.7 * (slot.full - slot.half),
    -1,
  );

  await page.getByRole("button", { name: "Collapse to strip" }).click();
  await expect(sheet).toHaveClass(/bottom-sheet--peek/);
  const range = page.getByRole("slider", { name: "Inspector height" });
  await range.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sheet).toHaveClass(/bottom-sheet--half/);
  await expect(range).toHaveAttribute("aria-valuetext", "Half height");
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
  await fingers.down(body);
  await page.waitForTimeout(HOLD_MS);
  await expect(page.getByRole("menu", { name: /^Create at / })).toBeVisible();
  await fingers.join(body, { x: body.x - 80, y: body.y + 30 });
  await fingers.up();
  await page.waitForTimeout(600);
  const menuAfter = await page
    .getByRole("menu", { name: /^Create at / })
    .count();
  json(info, `grammar-second-finger-${browserName}`, {
    commands: commands.map((c) => c.type),
    armedAfter,
    menuAfter,
  });
  expect(commands.filter((c) => c.type === "SetEnvelope")).toEqual([]);
  expect(armedAfter).toBe(0);
  expect(menuAfter).toBe(0);
});

/** The join at 50 s made a 200 ms crossfade; returns its right clip's id. */
async function crossfadeAt50(page: Page): Promise<string> {
  const rows = (await projectJson(page, projectPath)).clips.tracks[TRACK];
  const i = rows.findIndex((c) => c.timeline_start === 50);
  if (i < 1) throw new Error("join at 50 s missing");
  await postDocumentCommand(
    page,
    CLIENT_ID,
    "SetClipJoin",
    {
      left_clip_id: rows[i - 1].id,
      right_clip_id: rows[i].id,
      mode: "crossfade",
      length_ms: 200,
    },
    projectPath,
  );
  return rows[i].id;
}

test("the crossfade grip drags only once a long press arms it", async ({
  page,
  context,
  browserName,
}, info) => {
  const rightId = await openWith(page, () => crossfadeAt50(page));
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  await tap(
    page,
    finger,
    await centerOf(
      page,
      `${lane} [data-hit-kind="join"][data-hit-id="${rightId}"]`,
    ),
  );
  const grip = page.getByRole("button", {
    name: /Drag crossfade right endpoint/,
  });
  await expect(grip).toBeVisible();
  await expect(grip).toHaveAttribute("data-hit-kind", "crossfade-end");
  const from = await centerOfLocator(grip);
  // One finger sliding along the grip: no draft and no save.
  await finger.down(from);
  await finger.slide({ x: from.x - 40, y: from.y });
  await expect(page.locator(".join-edit-caption")).not.toContainText("Draft");
  await finger.up();
  await page.waitForTimeout(600);
  const afterSlide = commands.map((c) => c.type);

  const armedFrom = await centerOfLocator(grip);
  await hold(page, finger, armedFrom);
  await expect(armed(page)).toHaveCount(1);
  await expect(grip).toHaveAttribute("data-hit-armed", "");
  await frame(page, info, `crossfade-armed-${browserName}`);
  await finger.slide({ x: armedFrom.x - 8, y: armedFrom.y });
  await expect(page.locator(".join-edit-caption")).toContainText("Draft");
  await frame(page, info, `crossfade-dragging-${browserName}`);
  await finger.up();
  await expect
    .poll(() => commands.filter((c) => c.type === "SetClipJoin").length)
    .toBe(1);
  json(info, `crossfade-${browserName}`, {
    afterSlide,
    commands: commands.map((c) => ({ type: c.type, payload: c.payload })),
  });
  expect(afterSlide).not.toContain("SetClipJoin");
  expect(
    commands.find((c) => c.type === "SetClipJoin")?.payload.length_ms,
  ).toBeLessThan(200);
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
  // the seam's roll and that clip's ripple trim crowd one spot.
  const seam = await centerOf(
    page,
    `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`,
  );
  await tap(page, finger, { x: seam.x + 60, y: seam.y });
  const crowded = await centerOf(
    page,
    `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`,
  );
  await hold(page, finger, crowded);
  const chooser = page.getByRole("menu", { name: "Targets here" });
  await expect(chooser).toBeVisible();
  const chips = await chooser
    .getByRole("menuitemradio")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  const trimChip = chooser.getByRole("menuitemradio", { name: /^Trim start/ });
  const chip = await centerOfLocator(trimChip);
  await finger.slide(chip, 6, 30);
  await page.waitForTimeout(HOLD_MS);
  await finger.slide({ x: chip.x + 40, y: chip.y }, 8, 30);
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
  expect(chips.some((label) => label?.startsWith("Roll"))).toBe(true);
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

test("#1154: a touch ripple trim over the guest's speech asks first, and Leave a gap keeps it", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const pps = await setZoom(page, 1);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const seam = await centerOf(
    page,
    `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`,
  );
  await tap(page, finger, { x: seam.x + 20, y: seam.y });
  const crowded = await centerOf(
    page,
    `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`,
  );
  await hold(page, finger, crowded);
  const chooser = page.getByRole("menu", { name: "Targets here" });
  await expect(chooser).toBeVisible();
  const chip = await centerOfLocator(
    chooser.getByRole("menuitemradio", { name: /^Trim start/ }),
  );
  await finger.slide(chip, 6, 30);
  await page.waitForTimeout(HOLD_MS);
  // The reference clip from 40 s loses its first 6 s; the guest speaks from
  // 43.5 s, so the ripple would cut "antonia pointed up to the sky".
  await finger.slide({ x: chip.x + 6 * pps, y: chip.y }, 12, 30);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await finger.up();
  const dialog = page.getByRole("dialog", { name: "Cut guest's speech too?" });
  await expect(dialog).toBeVisible();
  await frame(page, info, `cut-speech-asked-${browserName}`);
  const trims = () => commands.filter((c) => c.type === "TrimClipEdge");
  expect(trims().map((c) => c.payload.mode)).toEqual(["ripple"]);
  expect(trims()[0].payload).not.toHaveProperty("confirm_cut_speech");
  const asked = (await projectJson(page, projectPath)).clips.tracks;
  expect(asked[TRACK].map((c) => c.timeline_start)).toEqual([0, 10, 40, 50]);

  const leaveGap = await centerOfLocator(
    dialog.getByRole("button", { name: "Leave a gap" }),
  );
  await tap(page, finger, leaveGap);
  await expect(dialog).toBeHidden();
  await expect.poll(() => trims().length).toBe(2);
  expect(trims()[1].payload.mode).toBe("gap");
  expect(trims()[1].payload).not.toHaveProperty("confirm_cut_speech");
  const after = (await projectJson(page, projectPath)).clips.tracks;
  const starts = after[TRACK].map((c) => c.timeline_start);
  await expect(page.locator(".guest-attention")).toHaveCount(0);
  await frame(page, info, `cut-speech-gap-${browserName}`);
  json(info, `cut-speech-${browserName}`, {
    pps,
    starts,
    guest: after.guest.map((c) => c.timeline_start),
    commands: trims().map((c) => c.payload),
  });
  expect(starts).toHaveLength(4);
  expect(starts.slice(0, 2)).toEqual([0, 10]);
  expect(starts[2]).toBeGreaterThan(44);
  expect(starts[3]).toBe(50);
  expect(after.guest).toEqual(asked.guest);
  await expect(
    page.getByRole("status").filter({ hasText: "Left a gap" }),
  ).toHaveCount(1);
});

test("#1135: a plain mouse grab at a join rolls it, as on main", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  await setZoom(page, 3);
  const commands = watchCommands(page);
  const seam = await centerOf(
    page,
    `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`,
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
