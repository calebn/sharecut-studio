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
import { setTheme } from "../e2e/theme";
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
  rootPx = 16,
  theme: "dark" | "light" = "dark",
): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(".daw-shell")).toBeVisible();
  if (size.width < 768) await openPhoneTimeline(page);
  await setTheme(page, theme);
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
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
      width: r.width,
      height: r.height,
      onTop: hit !== null && (el === hit || el.contains(hit)),
      hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
    };
  });
}

const railHistory = (page: Page) =>
  page.getByRole("group", { name: "Undo and redo" });
const compactHistory = (page: Page) =>
  page.locator(".bottom-sheet--compact").getByRole("group", {
    name: "Undo and redo",
  });

async function savedEnvelope(page: Page) {
  const res = await page.request.get(
    `/api/project?path=${encodeURIComponent(projectPath)}&phase=full`,
  );
  const body = (await res.json()) as {
    envelopes: {
      track_id: string;
      points: { id: string; time: number; value: number }[];
    }[];
  };
  return body.envelopes.find((e) => e.track_id === TRACK)?.points;
}

type Fixtures = Pick<PlaywrightTestArgs, "page" | "context"> & {
  browserName: string;
};

/** Undo and Redo are in view and on top before and after an edit, and a tap on Undo undoes it. */
async function undoStaysReachable(
  name: keyof typeof SIZES,
  rootPx: number,
  theme: "dark" | "light",
  { page, context, browserName }: Fixtures,
  info: TestInfo,
): Promise<void> {
  await openAt(page, SIZES[name], 16, theme);
  const finger = await newFinger(context, page, browserName);
  const commands = watchCommands(page);
  const measure = async (controls: Locator) => {
    const undo = controls.getByRole("button", { name: "Undo" });
    const redo = controls.getByRole("button", { name: "Redo" });
    const boxes = await page
      .locator(".bottom-sheet--compact .bottom-sheet-header-actions button")
      .evaluateAll((buttons) =>
        buttons
          .filter(
            (button) =>
              button.getAttribute("aria-label") !== "Undo" &&
              button.getAttribute("aria-label") !== "Redo",
          )
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            };
          }),
      );
    const historyBoxes = await Promise.all(
      [undo, redo].map((button) => button.boundingBox()),
    );
    const overlaps = historyBoxes.some(
      (box) =>
        box &&
        boxes.some(
          (other) =>
            other.left < box.x + box.width &&
            other.right > box.x &&
            other.top < box.y + box.height &&
            other.bottom > box.y,
        ),
    );
    return {
      undo: await reach(undo),
      redo: await reach(redo),
      otherControls: await Promise.all(
        (
          await page
            .locator(
              ".bottom-sheet--compact .bottom-sheet-header-actions button",
            )
            .all()
        ).map((button) => reach(button)),
      ),
      overlaps,
      visibleLaneHeight: await page.evaluate(() => {
        const lane = document
          .querySelector(".timeline-scroll")
          ?.getBoundingClientRect();
        const strip = document
          .querySelector(".bottom-sheet")
          ?.getBoundingClientRect();
        const chrome = document
          .querySelector(".bottom-sheet-chrome")
          ?.getBoundingClientRect();
        return {
          visible:
            lane && strip
              ? Math.max(0, Math.min(lane.bottom, strip.top) - lane.top)
              : 0,
          lane: lane?.toJSON(),
          strip: strip?.toJSON(),
          chrome: chrome?.toJSON(),
          shell: document.documentElement.dataset.shell,
          layout: document.documentElement.dataset.layout,
        };
      }),
    };
  };
  const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  const check = async (step: string, controls: Locator) => {
    seen[step] = await measure(controls);
  };
  await check("rail", railHistory(page));

  const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
  await finger.down(at);
  await page.waitForTimeout(60);
  await finger.up();
  await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
  await page.evaluate((px) => {
    document.documentElement.style.fontSize = `${px}px`;
  }, rootPx);
  await page.waitForTimeout(600);
  const headerHistory = compactHistory(page);
  await check("peek", headerHistory);
  const census = await page
    .locator(".bottom-sheet--compact")
    .evaluate((panel) => {
      const selectors = [
        ".bottom-sheet-chrome",
        ".bottom-sheet-header",
        ".bottom-sheet-title",
        ".bottom-sheet-header-actions",
        ".bottom-sheet-body",
        ".peek-strip",
      ];
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          visualHeight: visualViewport?.height,
          visualOffset: visualViewport?.offsetTop,
        },
        root: {
          rect: panel.parentElement?.getBoundingClientRect().toJSON(),
          bottom: panel.parentElement
            ? getComputedStyle(panel.parentElement).bottom
            : null,
        },
        shell: {
          rect: document
            .querySelector(".daw-shell")
            ?.getBoundingClientRect()
            .toJSON(),
          style: document.documentElement.style.cssText,
        },
        panel: {
          className: panel.className,
          rect: panel.getBoundingClientRect().toJSON(),
        },
        children: selectors.map((selector) => {
          const el = panel.querySelector(selector);
          const style = el ? getComputedStyle(el) : null;
          return {
            selector,
            text: el?.textContent,
            rect: el?.getBoundingClientRect().toJSON(),
            padding: style?.padding,
            gap: style?.gap,
            flex: style?.flex,
          };
        }),
        buttons: [...panel.querySelectorAll("button")].map((el) => ({
          name: el.getAttribute("aria-label"),
          rect: el.getBoundingClientRect().toJSON(),
          padding: getComputedStyle(el).padding,
        })),
      };
    });
  json(info, `census-${name}-${rootPx}-${theme}`, census);
  await info.attach("peek", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  for (const detent of ["half", "full", "peek"] as const) {
    if (detent === "half") {
      await page.getByRole("button", { name: "Expand to half height" }).click();
    } else if (detent === "full") {
      await page.getByRole("button", { name: "Expand to full height" }).click();
    } else {
      await page.getByRole("button", { name: "Collapse to strip" }).click();
    }
    await page.waitForTimeout(350);
    await check(detent, headerHistory);
  }

  const original = [
    { id: "env-a", time: 5, value: 1 },
    { id: "env-edge", time: 10, value: 0.8 },
    { id: "env-c", time: 16, value: 1 },
    { id: "env-join", time: 40, value: 1.2 },
  ];
  const edited = original.map((point) =>
    point.id === "env-c" ? { ...point, time: 16.01 } : point,
  );
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const nudge = page.getByRole("button", {
    name: "Envelope point 0.01 s later",
    exact: true,
  });
  const nudgeBox = await nudge.boundingBox();
  if (!nudgeBox) throw new Error("Nudge has no box");
  await finger.down({
    x: nudgeBox.x + nudgeBox.width / 2,
    y: nudgeBox.y + nudgeBox.height / 2,
  });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  await page.waitForTimeout(900);
  await check("strip-open-after-edit", headerHistory);
  json(info, `chrome-undo-${name}-${rootPx}-${theme}-${browserName}`, seen);

  for (const [step, row] of Object.entries(seen)) {
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
    expect(row.undo.width).toBeGreaterThanOrEqual(44);
    expect(row.undo.height).toBeGreaterThanOrEqual(44);
    expect(row.redo.width).toBeGreaterThanOrEqual(44);
    expect(row.redo.height).toBeGreaterThanOrEqual(44);
    for (const control of row.otherControls) {
      expect({ step, ...control }).toMatchObject({
        step,
        inView: true,
        onTop: true,
      });
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
    expect(row.overlaps).toBe(false);
    if (
      rootPx === 16 &&
      (step === "peek" || step === "strip-open-after-edit")
    ) {
      expect(row.visibleLaneHeight.visible).toBeGreaterThanOrEqual(
        name === "portrait" ? 547 : 191,
      );
    }
  }

  await expect(page.locator(".bottom-sheet--peek")).toBeVisible();
  const undo = headerHistory.getByRole("button", { name: "Undo" });
  const box = await undo.boundingBox();
  if (!box) throw new Error("Undo has no box");
  commands.length = 0;
  await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const undoCommands = commands.map((c) => c.type);
  expect(undoCommands).toEqual(["UndoHistory"]);
  const redo = headerHistory.getByRole("button", { name: "Redo" });
  const redoBox = await redo.boundingBox();
  if (!redoBox) throw new Error("Redo has no box");
  commands.length = 0;
  await finger.down({
    x: redoBox.x + redoBox.width / 2,
    y: redoBox.y + redoBox.height / 2,
  });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(edited);
  expect(commands.map((c) => c.type)).toEqual(["RedoHistory"]);
  json(info, `saved-history-${name}-${rootPx}-${theme}-${browserName}`, {
    original,
    edited,
    undoCommands,
    redoCommands: commands,
  });
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

for (const name of ["portrait", "landscape"] as const) {
  for (const rootPx of [16, 32]) {
    for (const theme of ["dark", "light"] as const) {
      test(`compact history ${name} root${rootPx} ${theme}`, ({
        page,
        context,
        browserName,
      }, info) =>
        undoStaysReachable(
          name,
          rootPx,
          theme,
          { page, context, browserName },
          info,
        ));
    }
  }
}

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
