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

const original = [
  { id: "env-a", time: 5, value: 1 },
  { id: "env-edge", time: 10, value: 0.8 },
  { id: "env-c", time: 16, value: 1 },
  { id: "env-join", time: 40, value: 1.2 },
];
const edited = [
  { id: "env-a", time: 5, value: 1 },
  { id: "env-edge", time: 10, value: 0.8 },
  { id: "env-c", time: 16.01, value: 1 },
  { id: "env-join", time: 40, value: 1.2 },
];

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
    const identify = (node: Element) => ({
      tag: node.tagName,
      id: node.id,
      className: node.getAttribute("class"),
      name:
        node.getAttribute("aria-label") ??
        node.getAttribute("title") ??
        node.textContent,
      rect: node.getBoundingClientRect().toJSON(),
      position: getComputedStyle(node).position,
      zIndex: getComputedStyle(node).zIndex,
      pointerEvents: getComputedStyle(node).pointerEvents,
    });
    return {
      control: identify(el),
      stack: document
        .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        .map(identify),
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

async function receipt(info: TestInfo, name: string, value: unknown) {
  json(info, name, value);
  await info.attach(name, {
    body: JSON.stringify(value),
    contentType: "application/json",
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
      feedback: await page.evaluate(() => {
        const toast = document.querySelector(".ui-toast-region--app .ui-toast");
        if (!(toast instanceof HTMLElement)) return null;
        const feedback = toast.getBoundingClientRect();
        const panel = document.querySelector(".bottom-sheet--compact");
        const controls = Array.from(
          panel?.querySelectorAll(
            "button, input, select, textarea, label, [role='button']",
          ) ?? [],
        ).flatMap((element) => {
          if (
            !(element instanceof HTMLElement) ||
            element.closest("[inert], [hidden], .ui-toast")
          )
            return [];
          const style = getComputedStyle(element);
          if (style.visibility !== "visible" || style.display === "none")
            return [];
          const rect = element.getBoundingClientRect();
          let left = Math.max(0, rect.left);
          let right = Math.min(innerWidth, rect.right);
          let top = Math.max(0, rect.top);
          let bottom = Math.min(innerHeight, rect.bottom);
          for (
            let parent = element.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            const box = parent.getBoundingClientRect();
            const parentStyle = getComputedStyle(parent);
            if (
              ["hidden", "clip", "auto", "scroll"].includes(
                parentStyle.overflowX,
              )
            ) {
              left = Math.max(left, box.left);
              right = Math.min(right, box.right);
            }
            if (
              ["hidden", "clip", "auto", "scroll"].includes(
                parentStyle.overflowY,
              )
            ) {
              top = Math.max(top, box.top);
              bottom = Math.min(bottom, box.bottom);
            }
          }
          if (right <= left || bottom <= top) return [];
          return [
            {
              name: element.getAttribute("aria-label") ?? element.textContent,
              rect: rect.toJSON(),
              visible: { left, right, top, bottom },
              overlaps:
                left < feedback.right &&
                right > feedback.left &&
                top < feedback.bottom &&
                bottom > feedback.top,
            },
          ];
        });
        const dismiss = toast.querySelector("button:last-child");
        const dismissRect = dismiss?.getBoundingClientRect();
        const hit = dismissRect
          ? document.elementFromPoint(
              dismissRect.left + dismissRect.width / 2,
              dismissRect.top + dismissRect.height / 2,
            )
          : null;
        return {
          rect: feedback.toJSON(),
          inView:
            feedback.left >= 0 &&
            feedback.top >= 0 &&
            feedback.right <= innerWidth &&
            feedback.bottom <= innerHeight,
          dismissOnTop:
            dismiss != null &&
            hit != null &&
            (dismiss === hit || dismiss.contains(hit)),
          controls,
          overlaps: controls.filter((control) => control.overlaps),
        };
      }),
      feedbackActions: await Promise.all(
        (await page.locator(".ui-toast-region--app button").all()).map(
          (button) => reach(button),
        ),
      ),
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
          bottomChrome: document
            .querySelector(
              document.documentElement.dataset.shell === "phone"
                ? ".mobile-nav"
                : ".daw-shell > .status-bar",
            )
            ?.getBoundingClientRect()
            .toJSON(),
          shell: document.documentElement.dataset.shell,
          layout: document.documentElement.dataset.layout,
        };
      }),
    };
  };
  const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  const check = async (step: string, controls: Locator) => {
    const beforeReveal = await measure(controls);
    await receipt(
      info,
      `hit-${name}-${rootPx}-${theme}-${step}-before-header-reveal`,
      beforeReveal,
    );
    if (beforeReveal.feedback)
      expect(beforeReveal.feedback.overlaps).toEqual([]);
    const header = page.locator(
      ".bottom-sheet--compact .bottom-sheet-header-actions",
    );
    if (await header.count()) await header.scrollIntoViewIfNeeded();
    seen[step] = await measure(controls);
    await receipt(info, `hit-${name}-${rootPx}-${theme}-${step}`, seen[step]);
    await info.attach(`hit-${step}`, {
      body: await page.screenshot({
        path: info.outputPath(`hit-${step}.png`),
      }),
      contentType: "image/png",
    });
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
  await receipt(info, `census-${name}-${rootPx}-${theme}`, census);
  const screenshot = info.outputPath(`peek-${name}-${rootPx}-${theme}.png`);
  const image = await page.screenshot({ path: screenshot });
  await info.attach("peek", { body: image, contentType: "image/png" });

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
  await expect(page.locator(".guest-attention")).not.toBeVisible();
  await check("strip-open-after-edit", headerHistory);
  for (const detent of ["half", "full", "peek"] as const) {
    await page
      .getByRole("button", {
        name:
          detent === "half"
            ? "Expand to half height"
            : detent === "full"
              ? "Expand to full height"
              : "Collapse to strip",
      })
      .click();
    await check(`feedback-${detent}`, headerHistory);
  }
  await page
    .locator(".ui-toast-region--app")
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.locator(".ui-toast-region--app .ui-toast")).toHaveCount(0);
  await check("feedback-dismissed", headerHistory);
  await receipt(
    info,
    `chrome-undo-${name}-${rootPx}-${theme}-${browserName}`,
    seen,
  );

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
      step === "strip-open-after-edit" ||
      ["feedback-peek", "feedback-half", "feedback-full"].includes(step)
    ) {
      expect(
        row.feedback,
        "Saved feedback must still be visible",
      ).not.toBeNull();
      for (const action of row.feedbackActions) {
        expect(action).toMatchObject({ inView: true, onTop: true });
        expect(action.width).toBeGreaterThanOrEqual(44);
        expect(action.height).toBeGreaterThanOrEqual(44);
      }
      expect(row.feedback).toMatchObject({
        inView: true,
        dismissOnTop: true,
        overlaps: [],
      });
    }
    if (step !== "rail") {
      expect(row.visibleLaneHeight.strip?.bottom).toBeCloseTo(
        row.visibleLaneHeight.bottomChrome?.top ?? -1,
        0,
      );
    }
    if (rootPx === 16 && (step === "peek" || step === "feedback-dismissed")) {
      expect(row.visibleLaneHeight.visible).toBeCloseTo(
        name === "portrait" ? 547 : 191,
        0,
      );
    }
  }

  await expect(page.locator(".bottom-sheet--peek")).toBeVisible();
  const undo = headerHistory.getByRole("button", { name: "Undo" });
  await expect(undo).not.toHaveAttribute("aria-disabled", "true");
  const box = await undo.boundingBox();
  if (!box) throw new Error("Undo has no box");
  commands.length = 0;
  await finger.down({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await page.waitForTimeout(60);
  await finger.up();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const savedUndo = await savedEnvelope(page);
  const undoCommands = commands.map((c) => c.type);
  expect(undoCommands).toEqual(["UndoHistory"]);
  const redo = headerHistory.getByRole("button", { name: "Redo" });
  await expect(redo).not.toHaveAttribute("aria-disabled", "true");
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
  await receipt(
    info,
    `saved-history-${name}-${rootPx}-${theme}-${browserName}`,
    {
      original,
      edited,
      savedUndo,
      savedRedo: await savedEnvelope(page),
      undoCommands,
      redoCommands: commands,
    },
  );
  await undo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  const levelEdited = [
    { id: "env-a", time: 5, value: 1 },
    { id: "env-edge", time: 10, value: 0.8 },
    { id: "env-c", time: 16, value: 1.01 },
    { id: "env-join", time: 40, value: 1.2 },
  ];
  const level = page.getByRole("button", {
    name: "Envelope point level 0.01 higher",
    exact: true,
  });
  await level.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
  await check("level-saved", headerHistory);
  expect(seen["level-saved"].feedback).toMatchObject({
    inView: true,
    dismissOnTop: true,
    overlaps: [],
  });
  commands.length = 0;
  await undo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(original);
  expect(commands.map((c) => c.type)).toEqual(["UndoHistory"]);
  const levelUndo = await savedEnvelope(page);
  commands.length = 0;
  await redo.click();
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
  expect(commands.map((c) => c.type)).toEqual(["RedoHistory"]);
  await receipt(
    info,
    `level-history-${name}-${rootPx}-${theme}-${browserName}`,
    {
      original,
      levelEdited,
      savedUndo: levelUndo,
      savedRedo: await savedEnvelope(page),
      redoCommands: commands,
    },
  );
  const liveCard = page.locator(".ui-toast-region--app .ui-toast");
  await expect(liveCard).toBeVisible();
  await liveCard.evaluate((card) =>
    card.setAttribute("data-host-proof", "same-card"),
  );
  await page
    .locator(".bottom-sheet-header")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(".bottom-sheet--compact")).toHaveCount(0);
  await expect(liveCard).toHaveAttribute("data-host-proof", "same-card");
  await expect(page.locator(".ui-toast-region--app")).not.toHaveClass(
    /inspector-flow/,
  );
  const floatingDismiss = liveCard.getByRole("button", { name: "Dismiss" });
  expect(await reach(floatingDismiss)).toMatchObject({
    inView: true,
    onTop: true,
  });
  await floatingDismiss.click();
  await expect(liveCard).toHaveCount(0);
  await expect.poll(() => savedEnvelope(page)).toEqual(levelEdited);
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
      test.describe(`compact history ${name} root${rootPx} ${theme}`, () => {
        test("Undo and Redo stay on top, and a tap on Undo undoes the edit, with the strip open", ({
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
      });
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

for (const pending of ["wait", "refuse"] as const) {
  test.describe(`pending save ${pending}`, () => {
    test("compact header handles Undo while a save is pending", async ({
      page,
      context,
      browserName,
    }, info) => {
      await openAt(page, SIZES.landscape);
      const finger = await newFinger(context, page, browserName);
      const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
      await finger.down(at);
      await page.waitForTimeout(60);
      await finger.up();
      await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.waitForTimeout(600);
      let releaseSave = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await page.route("**/api/document/command*", async (route) => {
        const body = route.request().postDataJSON() as { type: string };
        if (body.type === "SetEnvelope") await gate;
        await route.continue();
      });
      const commands = watchCommands(page);
      const tap = async (button: Locator) => {
        const box = await button.boundingBox();
        if (!box) throw new Error("Button has no box");
        await finger.down({
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        });
        await page.waitForTimeout(60);
        await finger.up();
      };
      try {
        await tap(
          page.getByRole("button", {
            name: "Envelope point 0.01 s later",
            exact: true,
          }),
        );
        await expect
          .poll(() => commands.map((command) => command.type))
          .toEqual(["SetEnvelope"]);
        await tap(
          compactHistory(page).getByRole("button", {
            name: "Undo",
            exact: true,
          }),
        );
        await page.waitForTimeout(200);
        expect(commands.map((command) => command.type)).toEqual([
          "SetEnvelope",
        ]);
        await expect.poll(() => savedEnvelope(page)).toEqual(original);
        if (pending === "refuse") {
          await expect(page.locator(".ui-toast-region--app")).toContainText(
            "Your last edit is still saving. Nothing was undone.",
            { timeout: 7000 },
          );
          expect(commands.map((command) => command.type)).toEqual([
            "SetEnvelope",
          ]);
        }
        releaseSave();
        if (pending === "wait") {
          await expect
            .poll(() => commands.map((command) => command.type))
            .toEqual(["SetEnvelope", "UndoHistory"]);
          await expect.poll(() => savedEnvelope(page)).toEqual(original);
        } else {
          await expect.poll(() => savedEnvelope(page)).toEqual(edited);
          expect(commands.map((command) => command.type)).toEqual([
            "SetEnvelope",
          ]);
        }
        await receipt(info, `pending-save-${pending}-${browserName}`, {
          commands,
          saved: await savedEnvelope(page),
        });
      } finally {
        releaseSave();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  });
}

for (const name of ["portrait", "landscape"] as const) {
  for (const rootPx of [16, 32]) {
    test.describe(`unavailable compact history ${name} root${rootPx}`, () => {
      test("unavailable compact history keeps geometry", async ({
        page,
        context,
        browserName,
      }, info) => {
        await openAt(page, SIZES[name]);
        const finger = await newFinger(context, page, browserName);
        const at = await centerOf(page, `${lane} [data-hit-id="env-c"]`);
        await finger.down(at);
        await page.waitForTimeout(60);
        await finger.up();
        await expect(page.locator(".bottom-sheet--compact")).toBeVisible();
        await page.evaluate((px) => {
          document.documentElement.style.fontSize = `${px}px`;
        }, rootPx);
        await page.waitForTimeout(600);
        const history = compactHistory(page);
        const commands = watchCommands(page);
        const geometry = () =>
          page.locator(".bottom-sheet--compact").evaluate((panel) => ({
            panel: panel.getBoundingClientRect().toJSON(),
            header: panel
              .querySelector(".bottom-sheet-header")
              ?.getBoundingClientRect()
              .toJSON(),
            body: panel
              .querySelector(".bottom-sheet-body")
              ?.getBoundingClientRect()
              .toJSON(),
            controls: [
              ...panel.querySelectorAll(".bottom-sheet-header button"),
            ].map((button) => button.getBoundingClientRect().toJSON()),
          }));
        for (const detent of ["peek", "half", "full"] as const) {
          if (detent !== "peek") {
            await page
              .getByRole("button", {
                name:
                  detent === "half"
                    ? "Expand to half height"
                    : "Expand to full height",
              })
              .click();
            await page.waitForTimeout(350);
          }
          const before = await geometry();
          const redo = history.getByRole("button", {
            name: "Redo",
            exact: true,
          });
          await expect(redo).toHaveAttribute("aria-disabled", "true");
          const box = await redo.boundingBox();
          if (!box) throw new Error("Redo has no box");
          await finger.down({
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
          await page.waitForTimeout(60);
          await finger.up();
          const hint = history.getByRole("status");
          await expect(hint).toHaveText("Nothing to redo");
          await expect(hint).toBeInViewport({ ratio: 1 });
          const after = await geometry();
          expect(after).toEqual(before);
          expect(commands).toEqual([]);
          await receipt(
            info,
            `unavailable-${name}-${rootPx}-${detent}-${browserName}`,
            { before, after },
          );
        }
      });
    });
  }
}
