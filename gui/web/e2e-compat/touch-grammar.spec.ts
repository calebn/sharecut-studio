import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { STUDIO_AXE_DISABLED_RULES } from "../e2e/axe";
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
  save,
  setZoom,
  TRACK,
  visiblePoint,
  watchCommands,
} from "../e2e/touchTimeline";

/*
 * #1051 round 4b, the touch grammar on a 430x932 iPhone viewport: a
 * long-press arms a target and only it drags, along its own axes; a
 * long-press on empty space opens the create menu; an armed drag detents
 * at a soft boundary; the strip swipes between drawer detents; a second
 * finger cancels it all. #1135: a long-press at a join offers the ripple
 * trim, whose drag keeps the edge under the finger and shows how far later
 * clips will move. Chromium drives CDP touch, WebKit touch-typed pointer
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

async function open(page: Page, theme: "dark" | "light" = "dark") {
  await page.setViewportSize(IPHONE);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(
    `/?project=${encodeURIComponent(projectPath)}&lab=touch-chooser`,
  );
  await expect(page.locator(".daw-shell")).toBeVisible();
  await openPhoneTimeline(page);
  await setTheme(page, theme);
  await setZoom(page, 3);
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

test("a long-press on empty space opens the create menu; Add envelope point adds one there", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  // The guest's lane: one long clip, no envelope points or pending edits.
  const body = await visiblePoint(
    page,
    '.lane-row:not([data-track-id="reference"])',
    0.5,
    0.6,
  );
  if (!body) throw new Error("guest lane not in view");
  await hold(page, finger, body);
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
  expect(items.slice(1)).toEqual(["Blade cut", "Add chapter", "Add comment"]);
  const added = commands.find((c) => c.type === "SetEnvelope")?.payload as
    | { track_id: string; points: unknown[] }
    | undefined;
  expect(added?.track_id).not.toBe(TRACK);
  expect(added?.points).toHaveLength(1);
});

test("the strip swipes between peek, half and full, and its buttons still work", async ({
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
  const grab = async () => {
    const box = await page.locator(".bottom-sheet-grabber").boundingBox();
    if (!box) throw new Error("no grabber");
    return { x: box.x + box.width / 2 + 60, y: box.y + 4 };
  };
  const swipe = async (dy: number) => {
    const at = await grab();
    await finger.down(at);
    await finger.slide({ x: at.x, y: at.y + dy }, 10, 30);
    await finger.up();
    await page.waitForTimeout(400);
  };
  await swipe(-120);
  await expect(sheet).toHaveClass(/bottom-sheet--half/);
  await frame(page, info, `grammar-drawer-half-${browserName}`);
  await swipe(-160);
  await expect(sheet).toHaveClass(/bottom-sheet--full/);
  await frame(page, info, `grammar-drawer-full-${browserName}`);
  await swipe(120);
  await expect(sheet).toHaveClass(/bottom-sheet--half/);
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
  await open(page);
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

  const body = await visiblePoint(page, lane, 0.5, 0.75);
  if (!body) throw new Error("lane not in view");
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
  await finger.up();
  await expect
    .poll(() => commands.filter((c) => c.type === "TrimClipEdge").length)
    .toBe(1);
  await page.waitForTimeout(400);
  await frame(page, info, `ripple-landed-${browserName}`);
  json(info, `ripple-${browserName}`, {
    chips,
    arrows,
    commands: commands.map((c) => ({ type: c.type, payload: c.payload })),
  });
  expect(chips.some((label) => label?.startsWith("Roll"))).toBe(true);
  expect(arrows).toBeGreaterThan(0);
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
