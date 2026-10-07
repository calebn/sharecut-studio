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

/*
 * #1184 precision drag lab, one run per variant on a 390x844 phone: a
 * long-press arms the last clip's trim end, the variant moves it exactly one
 * 10 ms step, and the save lands there; a second finger cancels the same
 * drag and saves nothing. Chromium drives CDP touch, WebKit touch-typed
 * pointer events (e2e/finger.ts). Frames go to TOUCH_CHOOSER_EVIDENCE_DIR.
 */

const CLIENT_ID = "e2e-precision-drag";
const PHONE = { width: 390, height: 844 };
const HOLD_MS = 750;
const VARIANTS = ["jog", "lens", "grip"] as const;
type Variant = (typeof VARIANTS)[number];

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

async function open(page: Page, variant: Variant): Promise<Clip> {
  await page.setViewportSize(PHONE);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  const clip = await lastClip(page);
  await page.goto(
    `/?project=${encodeURIComponent(projectPath)}&lab=precision:${variant}`,
  );
  await expect(page.locator(".daw-shell")).toBeVisible();
  await openPhoneTimeline(page);
  await setTheme(page, "dark");
  await setZoom(page, 3);
  return clip;
}

async function frame(page: Page, info: TestInfo, name: string) {
  save(info, `${name}.png`, await page.screenshot());
}

const readout = (page: Page) => page.locator(".precision-delta").textContent();

/**
 * Moves the driving finger left 1 px at a time from `from` until the readout
 * says one step earlier; returns where it stopped and the readouts seen.
 */
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

/** Answers the ripple's cut-speech question, if the trim asked it. */
async function cutAnywayIfAsked(page: Page) {
  const cut = page.getByRole("button", { name: "Cut anyway" });
  if (await cut.isVisible({ timeout: 1500 }).catch(() => false)) {
    await cut.click();
    return true;
  }
  return false;
}

async function savedEnd(page: Page, id: string) {
  const rows = (await projectJson(page, projectPath)).clips.tracks[
    TRACK
  ] as unknown as Clip[];
  return rows.find((c) => c.id === id)?.source_end;
}

/** Taps the clip's body so its edge handles show, then finds the trim end. */
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

for (const variant of VARIANTS) {
  test(`${variant}: moves a trim end exactly one 10 ms step and saves it`, async ({
    page,
    context,
    browserName,
  }, info) => {
    const clip = await open(page, variant);
    const commands = watchCommands(page);
    const finger = await newFinger(context, page, browserName);
    const at = await trimEndAt(page, finger, clip);
    await hold(page, finger, at);
    await expect(page.locator(".precision-layer")).toHaveAttribute(
      "data-variant",
      variant,
    );
    await expect(page.locator("[data-hit-armed]")).toHaveCount(1);
    await page.waitForTimeout(400);
    await frame(page, info, `precision-${variant}-armed-${browserName}`);
    let step: { at: Point; seen: string[] };
    let from = at;
    if (variant === "jog") {
      await finger.up();
      const pad = await page.locator(".precision-jog-pad").boundingBox();
      if (!pad) throw new Error("no jog pad");
      const start = { x: pad.x + pad.width / 2, y: pad.y + pad.height - 8 };
      await finger.down(start);
      // Up past three 40 px rungs: the fine speed.
      const fine = { x: start.x, y: start.y - 130 };
      await finger.slide(fine, 6, 16);
      await expect(page.locator(".precision-jog-hint")).toHaveText("Fine");
      from = fine;
      step = await oneStepLeft(page, (p) => finger.move(p), fine);
      await frame(page, info, `precision-${variant}-one-step-${browserName}`);
      await finger.up();
      await page.getByRole("button", { name: "Done" }).click();
    } else {
      step = await oneStepLeft(page, (p) => finger.move(p), at);
      await frame(page, info, `precision-${variant}-one-step-${browserName}`);
      await finger.up();
    }
    const asked = await cutAnywayIfAsked(page);
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
      askedCutSpeech: asked,
      commands: commands.map((c) => c.type),
    });
    expect(step.seen.at(-1)).toBe("−10 ms");
    expect(commands.filter((c) => c.type === "TrimClipEdge")).toHaveLength(1);
  });

  test(`${variant}: a second finger cancels the drag and saves nothing`, async ({
    page,
    context,
    browserName,
  }, info) => {
    const clip = await open(page, variant);
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
    let one = { x: at.x - 30, y: at.y };
    if (variant === "jog") {
      await fingers.up();
      const pad = await page.locator(".precision-jog-pad").boundingBox();
      if (!pad) throw new Error("no jog pad");
      const start = { x: pad.x + pad.width / 2, y: pad.y + pad.height / 2 };
      await fingers.down(start);
      one = { x: start.x - 30, y: start.y };
    }
    for (let k = 1; k <= 6; k += 1) {
      await fingers.move({ x: one.x + (30 * (6 - k)) / 6, y: one.y });
      await page.waitForTimeout(16);
    }
    const moved = await readout(page);
    await frame(
      page,
      info,
      `precision-${variant}-before-second-${browserName}`,
    );
    await fingers.join(one, { x: one.x + 120, y: one.y - 200 });
    await page.waitForTimeout(100);
    await frame(
      page,
      info,
      `precision-${variant}-second-finger-${browserName}`,
    );
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
}

async function centerOfLocator(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags the jog pad by `dx` px at full speed, then lifts. */
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
  const clip = await open(page, "jog");
  const commands = watchCommands(page);
  const finger = await newFinger(context, page, browserName);
  await hold(page, finger, await trimEndAt(page, finger, clip));
  await finger.up();
  await jog(page, finger, -6);
  const shown = await readout(page);
  // Empty timeline below the lanes.
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
  // The host's speech guard scans the cut span first; under load that has
  // taken ~10 s for this one.
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

test("jog: a ripple over the guest's speech asks first, and Leave a gap keeps it", async ({
  page,
  context,
  browserName,
}, info) => {
  await open(page, "jog");
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
  await expect(page.locator(".precision-jog")).toBeVisible();
  await finger.up();
  // The reference clip from 40 s loses its first 6 s; the guest speaks from
  // 43.5 s, so the ripple would cut their words.
  await jog(page, finger, 6 * pps);
  await expect(page.locator(".trim-readout")).toContainText("Ripple");
  await frame(page, info, `precision-jog-ripple-preview-${browserName}`);
  await page.getByRole("button", { name: "Done" }).click();
  const dialog = page.getByRole("dialog", { name: "Cut guest's speech too?" });
  await expect(dialog).toBeVisible();
  await frame(page, info, `precision-jog-cut-speech-asked-${browserName}`);
  await dialog.getByRole("button", { name: "Leave a gap" }).click();
  await expect(dialog).toBeHidden();
  const trims = () => commands.filter((c) => c.type === "TrimClipEdge");
  await expect.poll(() => trims().length).toBe(2);
  const starts = (await projectJson(page, projectPath)).clips.tracks[TRACK].map(
    (c) => c.timeline_start,
  );
  json(info, `precision-jog-cut-speech-${browserName}`, {
    pps,
    starts,
    modes: trims().map((c) => c.payload.mode),
  });
  expect(trims().map((c) => c.payload.mode)).toEqual(["ripple", "gap"]);
  expect(starts.slice(0, 2)).toEqual([0, 10]);
  expect(starts[2]).toBeGreaterThan(44);
  expect(starts[3]).toBe(50);
});

test("View › Labs switches the precision variant in place", async ({
  page,
  context,
  browserName,
}, info) => {
  const clip = await open(page, "jog");
  await page.getByRole("button", { name: "Menu" }).click();
  const lens = page.getByRole("menuitemradio", { name: "Auto-zoom lens" });
  await lens.scrollIntoViewIfNeeded();
  await frame(page, info, `precision-labs-menu-${browserName}`);
  await lens.click();
  await expect(lens).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  const finger = await newFinger(context, page, browserName);
  await hold(page, finger, await trimEndAt(page, finger, clip));
  await expect(page.locator(".precision-layer")).toHaveAttribute(
    "data-variant",
    "lens",
  );
  await finger.up();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".precision-layer")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("sharecut.labs.precision")),
  ).toBe("lens");
});
