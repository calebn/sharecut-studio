import {
  expect,
  type Locator,
  type Page,
  type PlaywrightTestArgs,
  type TestInfo,
  test,
} from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { newFinger } from "../e2e/finger";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import {
  buildFixture,
  centerOf,
  json,
  lane,
  setZoom,
  TRACK,
  watchCommands,
} from "../e2e/touchTimeline";

/*
 * #1181 round 9: controls the touch chrome must keep reachable. Undo and Redo
 * stay visible, on top and tappable before and after an edit, with the peek
 * strip open, on a phone held either way (the strip used to sit over the rail
 * and a tap meant for Undo nudged a pending edit instead). The "Confirm blade
 * cut" sheet's Cut button sits above the tab bar on a phone held sideways, at
 * every text size.
 */

const CLIENT_ID = "e2e-touch-chrome-reach";
const HOLD_MS = 750;
const SIZES = {
  portrait: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
} as const;

test.use({ hasTouch: true });
test.describe.configure({ timeout: 240_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-chrome-reach-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function openAt(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (size.width < 768) await openPhoneTimeline(page);
  await setZoom(page, 3);
}

/** Whether the centre of `target` is inside the viewport and is what a finger would hit. */
async function reach(target: Locator) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return {
      inView:
        r.left >= 0 &&
        r.top >= 0 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight,
      onTop: hit !== null && (el === hit || el.contains(hit)),
      hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
    };
  });
}

const history = (page: Page) =>
  page.getByRole("group", { name: "Undo and redo" });

async function envCTime(page: Page): Promise<number | undefined> {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const body = (await res.json()) as {
    envelopes: {
      track_id: string;
      points: { id: string; time: number }[];
    }[];
  };
  return body.envelopes
    .find((e) => e.track_id === TRACK)
    ?.points.find((p) => p.id === "env-c")?.time;
}

type Fixtures = Pick<PlaywrightTestArgs, "page" | "context"> & {
  browserName: string;
};

/** Undo and Redo are in view and on top before and after an edit, and a tap on Undo undoes it. */
async function undoStaysReachable(
  name: keyof typeof SIZES,
  { page, context, browserName }: Fixtures,
  info: TestInfo,
): Promise<void> {
  await openAt(page, SIZES[name]);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const undo = history(page).getByRole("button", { name: "Undo" });
  const redo = history(page).getByRole("button", { name: "Redo" });
  const seen: Record<string, unknown> = {};
  const check = async (step: string) => {
    seen[step] = { undo: await reach(undo), redo: await reach(redo) };
  };
  await check("start");

  const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  await page.waitForTimeout(600);
  await check("strip-open-after-tap");

  const from = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
  await finger.down(from);
  await page.waitForTimeout(HOLD_MS);
  await finger.slide({ x: from.x + 24, y: from.y - 12 });
  await finger.up();
  await expect.poll(() => envCTime(page)).toBeGreaterThan(16);
  await page.waitForTimeout(900);
  await check("strip-open-after-edit");
  json(info, `chrome-undo-${name}-${browserName}`, seen);

  for (const [step, state] of Object.entries(seen)) {
    const row = state as Record<string, { inView: boolean; onTop: boolean }>;
    expect({ step, ...row.undo }).toMatchObject({
      step,
      inView: true,
      onTop: true,
    });
    expect({ step, ...row.redo }).toMatchObject({
      step,
      inView: true,
      onTop: true,
    });
  }

  // A tap at Undo's centre undoes the edit: the strip does not swallow it.
  const box = await undo.boundingBox();
  if (!box) throw new Error("Undo has no box");
  commands.length = 0;
  await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => envCTime(page)).toBe(16);
  expect(commands.map((c) => c.type)).toEqual(["UndoHistory"]);
}

/** The blade confirmation's Cut is in view and on top at `rootPx`, and a tap on it cuts. */
async function cutIsTappable(
  name: keyof typeof SIZES,
  rootPx: number,
  { page, context, browserName }: Fixtures,
  info: TestInfo,
): Promise<void> {
  await openAt(page, SIZES[name]);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(400);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const tapCentre = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error("no box to tap");
    await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await page.waitForTimeout(60);
    await finger.up();
  };
  await tapCentre(
    page.getByRole("button", { name: "Blade", exact: true }).first(),
  );
  const cutAtPlayhead = page.getByRole("button", { name: /^Cut at playhead/ });
  await expect(cutAtPlayhead).toBeVisible();
  await tapCentre(cutAtPlayhead);
  const dialog = page.getByRole("dialog", { name: "Confirm blade cut" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(600);
  const cut = dialog.getByRole("button", { name: "Cut", exact: true });
  const state = await reach(cut);
  json(info, `chrome-blade-${name}-${rootPx}-${browserName}`, state);
  expect(state).toMatchObject({ inView: true, onTop: true });
  await tapCentre(cut);
  await expect(dialog).toHaveCount(0);
  expect(commands.map((c) => c.type)).toContain("SplitAtTime");
}

test("Undo and Redo stay on top, and a tap on Undo undoes the edit, with the strip open: portrait", ({
  page,
  context,
  browserName,
}, info) =>
  undoStaysReachable("portrait", { page, context, browserName }, info));

test("Undo and Redo stay on top, and a tap on Undo undoes the edit, with the strip open: landscape", ({
  page,
  context,
  browserName,
}, info) =>
  undoStaysReachable("landscape", { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 16px text: portrait", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("portrait", 16, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 32px text: portrait", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("portrait", 32, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 16px text: landscape", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("landscape", 16, { page, context, browserName }, info));

test("the Cut button of the blade confirmation can be tapped at 32px text: landscape", ({
  page,
  context,
  browserName,
}, info) =>
  cutIsTappable("landscape", 32, { page, context, browserName }, info));
