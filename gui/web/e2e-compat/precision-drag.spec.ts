import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { type Finger, newFinger, type Point, twoFingers } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";
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
  watchCommands,
} from "../e2e/touchTimeline";

const CLIENT_ID = "e2e-precision-drag";
const PHONE = { width: 390, height: 844 };
const HOLD_MS = 750;
test.use({ hasTouch: true });
test.describe.configure({ timeout: 300_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-precision-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

type Clip = { id: string; timeline_start: number; source_end: number };

async function lastClip(page: Page): Promise<Clip> {
  const rows = (await projectJson(page, projectPath)).clips.tracks[
    TRACK
  ] as unknown as Clip[];
  const clip = rows.find((c) => c.timeline_start === 50);
  if (!clip) throw new Error("clip at 50 s missing");
  return clip;
}

const trimEnd = (clip: Clip) =>
  `${lane} [data-clip-id="${clip.id}"] .trim-handle.out`;

async function openPhone(
  page: Page,
  zoomIns = 3,
): Promise<{ clip: Clip; pps: number }> {
  await page.setViewportSize(PHONE);
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  const clip = await lastClip(page);
  await expect(page.locator(".stage-frame")).toBeVisible();
  await openPhoneTimeline(page);
  await setTheme(page, "dark");
  const pps = await setZoom(page, zoomIns);
  return { clip, pps };
}

async function openJog(page: Page): Promise<Clip> {
  return (await openPhone(page)).clip;
}

const precisionLayer = (page: Page) => page.locator(".precision-layer");

async function frame(page: Page, info: TestInfo, name: string) {
  save(info, `${name}.png`, await page.screenshot());
}

const readout = (page: Page) => page.locator(".precision-delta").textContent();

async function oneStepLeft(
  page: Page,
  move: (to: Point) => Promise<void>,
  from: Point,
): Promise<{ at: Point; seen: string[] }> {
  const seen: string[] = [];
  const at = { ...from };
  for (let k = 0; k < 60; k += 1) {
    at.x -= 1;
    await move(at);
    const text = (await readout(page)) ?? "";
    seen.push(text);
    if (text !== "+0 ms") break;
  }
  return { at, seen };
}

async function savedEnd(page: Page, id: string) {
  const rows = (await projectJson(page, projectPath)).clips.tracks[
    TRACK
  ] as unknown as Clip[];
  return rows.find((c) => c.id === id)?.source_end;
}

async function trimEndAt(page: Page, finger: Finger, clip: Clip) {
  const body = await centerOf(page, `${lane} [data-clip-id="${clip.id}"]`);
  await finger.down(body);
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
  return centerOf(page, trimEnd(clip));
}

async function hold(page: Page, finger: Finger, at: Point) {
  await finger.down(at);
  await page.waitForTimeout(HOLD_MS);
}

test("jog: moves a trim end exactly one 10 ms step and saves it", async ({
  page,
  context,
  browserName,
}, info) => {
  const variant = "jog";
  const clip = await openJog(page);
  const commands = watchCommands(page);
  const finger = await newFinger(context, page, browserName);
  const at = await trimEndAt(page, finger, clip);
  await hold(page, finger, at);
  await expect(page.locator(".precision-layer")).toHaveAttribute(
    "data-variant",
    variant,
  );
  await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
  await expect(precisionLayer(page)).toHaveAttribute("data-mode", "precision");
  await page.waitForTimeout(400);
  await frame(page, info, `precision-${variant}-armed-${browserName}`);
  await finger.up();
  const pad = await page.locator(".precision-jog-pad").boundingBox();
  if (!pad) throw new Error("no jog pad");
  const start = { x: pad.x + pad.width / 2, y: pad.y + pad.height - 8 };
  await finger.down(start);
  const fine = { x: start.x, y: start.y - 130 };
  await finger.slide(fine, 6, 16);
  await expect(page.locator(".precision-jog-hint")).toHaveText("Fine");
  const step = await oneStepLeft(page, (p) => finger.move(p), fine);
  await frame(page, info, `precision-${variant}-one-step-${browserName}`);
  await finger.up();
  await page.getByRole("button", { name: "Done" }).click();
  const from = fine;
  await expect(page.locator(".precision-layer")).toHaveCount(0);
  await expect
    .poll(async () => savedEnd(page, clip.id), { timeout: 60_000 })
    .toBeCloseTo(clip.source_end - 0.01, 6);
  await page.waitForTimeout(500);
  await frame(page, info, `precision-${variant}-saved-${browserName}`);
  const after = await savedEnd(page, clip.id);
  json(info, `precision-${variant}-one-step-${browserName}`, {
    from: clip.source_end,
    after,
    readouts: step.seen,
    fingerPx: from.x - step.at.x,
    commands: commands.map((c) => c.type),
  });
  expect(step.seen.at(-1)).toBe("−10 ms");
  expect(commands.filter((c) => c.type === "TrimClipEdge")).toHaveLength(1);
});

test("jog: a second finger cancels the drag and saves nothing", async ({
  page,
  context,
  browserName,
}, info) => {
  const variant = "jog";
  const clip = await openJog(page);
  const commands = watchCommands(page);
  const fingers = await twoFingers(context, page, browserName);
  const at = await trimEndAt(
    page,
    await newFinger(context, page, browserName),
    clip,
  );
  await fingers.down(at);
  await page.waitForTimeout(HOLD_MS);
  await expect(page.locator(".precision-layer")).toBeVisible();
  await fingers.up();
  const pad = await page.locator(".precision-jog-pad").boundingBox();
  if (!pad) throw new Error("no jog pad");
  const start = { x: pad.x + pad.width / 2, y: pad.y + pad.height / 2 };
  await fingers.down(start);
  const one = { x: start.x - 30, y: start.y };
  for (let k = 1; k <= 6; k += 1) {
    await fingers.move({ x: one.x + (30 * (6 - k)) / 6, y: one.y });
    await page.waitForTimeout(16);
  }
  const moved = await readout(page);
  await frame(page, info, `precision-${variant}-before-second-${browserName}`);
  await fingers.join(one, { x: one.x + 120, y: one.y - 200 });
  await page.waitForTimeout(100);
  await frame(page, info, `precision-${variant}-second-finger-${browserName}`);
  await fingers.up();
  await page.waitForTimeout(800);
  const end = await savedEnd(page, clip.id);
  const layer = await page.locator(".precision-layer").count();
  const armed = await page.locator("[data-hit-armed]").count();
  json(info, `precision-${variant}-second-finger-${browserName}`, {
    moved,
    end,
    layer,
    armed,
    commands: commands.map((c) => c.type),
  });
  expect(moved).not.toBe("+0 ms");
  expect(layer).toBe(0);
  expect(armed).toBe(0);
  expect(end).toBe(clip.source_end);
  expect(commands.filter((c) => c.type === "TrimClipEdge")).toEqual([]);
});

async function centerOfLocator(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function jog(page: Page, finger: Finger, dx: number) {
  const pad = await page.locator(".precision-jog-pad").boundingBox();
  if (!pad) throw new Error("no jog pad");
  const start = {
    x: pad.x + pad.width / 2 - dx / 2,
    y: pad.y + pad.height - 8,
  };
  await finger.down(start);
  await finger.slide({ x: start.x + dx, y: start.y }, 10, 16);
  await finger.up();
}

test("jog: a tap outside the pad finishes and saves", async ({
  page,
  context,
  browserName,
}, info) => {
  const clip = await openJog(page);
  const commands = watchCommands(page);
  const finger = await newFinger(context, page, browserName);
  await hold(page, finger, await trimEndAt(page, finger, clip));
  await finger.up();
  await jog(page, finger, -6);
  const shown = await readout(page);
  const area = await page.locator(".timeline-scroll").boundingBox();
  if (!area) throw new Error("no timeline");
  await finger.down({
    x: area.x + area.width * 0.6,
    y: area.y + area.height * 0.7,
  });
  await page.waitForTimeout(60);
  await finger.up();
  await expect(page.locator(".precision-layer")).toHaveCount(0);
  expect(shown).toMatch(/^−\d+ ms$/);
  const ms = Number(shown?.replace(/[^\d]/g, ""));
  const asked = Date.now();
  await expect
    .poll(() => savedEnd(page, clip.id), { timeout: 60_000 })
    .toBeCloseTo(clip.source_end - ms / 1000, 6);
  const saveMs = Date.now() - asked;
  await frame(page, info, `precision-jog-tap-outside-${browserName}`);
  json(info, `precision-jog-tap-outside-${browserName}`, {
    saveMs,
    shown,
    from: clip.source_end,
    after: await savedEnd(page, clip.id),
    commands: commands.map((c) => c.type),
  });
  expect(commands.filter((c) => c.type === "TrimClipEdge")).toHaveLength(1);
});

test("jog: a ripple over the guest's speech applies as one manual trim", async ({
  page,
  context,
  browserName,
}, info) => {
  await openJog(page);
  const pps = await setZoom(page, 1);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const seam = `${lane} .join-seam[data-hit-kind="roll"] >> nth=1`;
  const near = await centerOf(page, seam);
  await finger.down({ x: near.x + 20, y: near.y });
  await page.waitForTimeout(60);
  await finger.up();
  await page.waitForTimeout(700);
  await hold(page, finger, await centerOf(page, seam));
  const chooser = page.getByRole("menu", { name: "Targets here" });
  await expect(chooser).toBeVisible();
  const chip = await centerOfLocator(
    chooser.getByRole("menuitemradio", { name: /^Trim start/ }),
  );
  await finger.slide(chip, 6, 30);
  await page.waitForTimeout(HOLD_MS);
  await finger.slide({ x: chip.x + 6 * pps, y: chip.y }, 12, 30);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await frame(page, info, `precision-ripple-preview-${browserName}`);
  await finger.up();
  const trims = () => commands.filter((c) => c.type === "TrimClipEdge");
  await expect.poll(() => trims().length).toBe(1);
  await expect(
    page.getByRole("dialog", { name: "Cut guest's speech too?" }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      (await projectJson(page, projectPath)).clips.tracks[TRACK].map(
        (c) => c.timeline_start,
      ),
    )
    .toHaveLength(4);
  await expect
    .poll(
      async () =>
        (await projectJson(page, projectPath)).clips.tracks[TRACK][3]
          .timeline_start,
    )
    .toBeLessThan(50);
  const starts = (await projectJson(page, projectPath)).clips.tracks[TRACK].map(
    (c) => c.timeline_start,
  );
  json(info, `precision-jog-cut-speech-${browserName}`, {
    pps,
    starts,
    modes: trims().map((c) => c.payload.mode),
  });
  expect(trims().map((c) => c.payload.mode)).toEqual(["ripple"]);
  expect(starts.slice(0, 3)).toEqual([0, 10, 40]);
  // The edge follows the finger: 6 steps of pps px is 6.0 to 6.2 s at this
  // zoom, so the clip starts at 50 minus that (a paused playhead near the edge
  // can stop it a little earlier, so the bound does not depend on where it is).
  expect(starts[3]).toBeGreaterThan(43.5);
  expect(starts[3]).toBeLessThan(50);
});

test("Auto drags directly when a step is 4 px wide at a deep zoom", async ({
  page,
  context,
  browserName,
}, info) => {
  const { clip, pps } = await openPhone(page, 22);
  const commands = watchCommands(page);
  const finger = await newFinger(context, page, browserName);
  const at = await trimEndAt(page, finger, clip);
  await hold(page, finger, at);
  await expect(precisionLayer(page)).toHaveAttribute("data-mode", "direct");
  await expect(page.locator(".precision-jog")).toHaveCount(0);
  await finger.slide({ x: at.x - 40, y: at.y }, 8, 16);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await frame(page, info, `precision-auto-direct-${browserName}`);
  await finger.up();
  await expect
    .poll(() => commands.filter((c) => c.type === "TrimClipEdge").length, {
      timeout: 60_000,
    })
    .toBe(1);
  await expect
    .poll(async () => savedEnd(page, clip.id), { timeout: 60_000 })
    .toBeLessThan(clip.source_end);
  const after = (await savedEnd(page, clip.id)) ?? clip.source_end;
  json(info, `precision-auto-direct-${browserName}`, {
    pps,
    from: clip.source_end,
    after,
    commands: commands.map((c) => c.type),
  });
  expect(clip.source_end - after).toBeLessThanOrEqual(40 / pps + 0.01);
  expect(Math.round((clip.source_end - after) * 1e6) % 10_000).toBe(0);
});
