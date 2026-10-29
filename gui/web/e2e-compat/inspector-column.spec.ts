import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { newFinger } from "../e2e/finger";
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
  inspectSelectionByKey,
  openProject,
  openToolsIfFolded,
} from "../e2e/stageNav";
import {
  buildFixture,
  type CaseFixtures,
  centerOf,
  lane,
  setZoom,
} from "../e2e/touchTimeline";

/*
 * #1696 a phone held sideways (a coarse pointer, at most 40rem tall and at
 * least 40rem wide) shows the selection Inspector as a column on the inline
 * end of the stage frame, not a bottom sheet: the stage body keeps the whole
 * row beside it, and the Player and tab bar keep the whole width. Narrower or taller
 * screens keep the sheet. Playwright cannot emulate iOS safe-area insets or a
 * real software keypad; the keyboard is the `--keyboard-inset` the column
 * reads from useKeyboardInset.
 */

const CLIENT_ID = "e2e-inspector-column";
const COLUMN = {
  "667x375 phone shell": { width: 667, height: 375, shell: "phone" },
  "844x390 tablet shell": { width: 844, height: 390, shell: "tablet" },
  "932x430 tablet shell": { width: 932, height: 430, shell: "tablet" },
} as const;
const SHEET = {
  "568x320 phone shell, narrower than 40rem": {
    width: 568,
    height: 320,
    shell: "phone",
  },
  "390x844 portrait": { width: 390, height: 844, shell: "phone" },
} as const;
type Layout = { width: number; height: number; shell: "phone" | "tablet" };

test.use({ hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 240_000 });

let projectPath: string;
let workspaceDir: string;

test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-inspector-column-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});

test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  if (workspaceDir) removeRelocatedE2eProject(workspaceDir);
});

async function open(page: Page, view: Layout, envelope: boolean) {
  await page.setViewportSize(view);
  await openProject(page, projectPath);
  await buildFixture(page, projectPath, CLIENT_ID);
  await openProject(page, projectPath);
  await expect(page.locator(`.stage-frame--${view.shell}`)).toBeVisible();
  if (view.shell === "phone") await openPhoneTimeline(page);
  await expect(page.locator(".lane-row").first()).toBeVisible();
  await openToolsIfFolded(page);
  await expect(
    page.getByRole("group", { name: "Timeline view" }),
  ).toBeVisible();
  await closeTools(page);
  if (envelope) {
    await layer(page, "Volume envelope", true);
    await expect(
      page.locator('circle[aria-label^="Envelope point 2"]'),
    ).toBeVisible();
    await setZoom(page, 3);
  }
}

async function selectEnvelopePoint({
  page,
  context,
  browserName,
}: CaseFixtures) {
  const finger = await newFinger(context, page, browserName);
  await finger.down(
    await centerOf(
      page,
      `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"]`,
    ),
  );
  await finger.up();
  await inspectSelection(page);
}

/**
 * The keyboard as `useKeyboardInset` publishes it: the visible band of the
 * layout viewport, `top` to `top + height`, plus the covered inset.
 */
async function setKeyboard(
  page: Page,
  band: { top: number; height: number; inset: number } | null,
) {
  await page.evaluate((next) => {
    const root = document.documentElement;
    if (next === null) {
      delete root.dataset.keyboard;
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
      root.style.removeProperty("--visual-viewport-height");
    } else {
      root.dataset.keyboard = "open";
      root.style.setProperty("--keyboard-inset", `${next.inset}px`);
      root.style.setProperty("--visual-viewport-top", `${next.top}px`);
      root.style.setProperty("--visual-viewport-height", `${next.height}px`);
    }
  }, band);
}

/**
 * Let the viewport's own resize event pass before a keyboard is faked: the
 * keyboard hook clears a keyboard that is not covering anything, and on a slow
 * runner that event can land after the fake is set.
 */
function settleViewport(page: Page) {
  return page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
}

/** The column's place, the stage body's, and the frame chrome around them. */
function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r
        ? {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          }
        : null;
    };
    const frame = document.querySelector(".stage-frame");
    // A box-less host (display: contents) does not stand between a grid item
    // and its grid.
    const gridParent = (el: Element | null) => {
      let parent = el?.parentElement ?? null;
      while (parent && getComputedStyle(parent).display === "contents")
        parent = parent.parentElement;
      return parent;
    };
    const column = document.querySelector(".bottom-sheet--column");
    return {
      inGrid: gridParent(column) === frame,
      column: box(column),
      position: column ? getComputedStyle(column).position : null,
      timeline: box(document.querySelector(".timeline-scroll")),
      body: box(document.querySelector(".stage-frame-body")),
      header: box(document.querySelector(".stage-frame-header")),
      player: box(document.querySelector(".stage-frame-player")),
      tabs: box(document.querySelector(".stage-frame-tabs")),
      sheetRoot: document.querySelector(".bottom-sheet-root") !== null,
      compact: document.querySelector(".bottom-sheet--compact") !== null,
      scrim: document.querySelector(".bottom-sheet-scrim") !== null,
      resize:
        column?.querySelector(
          ".bottom-sheet-resize-action, .bottom-sheet-detent",
        ) != null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

async function expectColumn(
  page: Page,
  view: Layout,
  label: string,
  insets: { right: number; bottom: number; left?: number } = {
    right: 0,
    bottom: 0,
  },
) {
  await expect(page.locator(".bottom-sheet--column"), label).toBeVisible();
  const g = await geometry(page);
  const column = g.column!;
  expect(g.inGrid, `${label}: a child of the frame grid`).toBe(true);
  expect(g.sheetRoot, `${label}: nothing portaled`).toBe(false);
  expect(g.compact, `${label}: no compact strip`).toBe(false);
  expect(g.scrim, `${label}: no scrim`).toBe(false);
  expect(g.resize, `${label}: no drawer or resize controls`).toBe(false);
  expect(column.right, `${label}: on the inline end`).toBeCloseTo(
    view.width - insets.right,
    0,
  );
  expect(
    column.left,
    `${label}: a side column, not the full width`,
  ).toBeGreaterThan(view.width * 0.5);
  expect(column.width, `${label}: a readable width`).toBeGreaterThanOrEqual(
    255,
  );
  expect(column.width, `${label}: no wider than 22rem`).toBeLessThanOrEqual(
    353,
  );
  expect(
    g.timeline!.right,
    `${label}: the timeline stops at the column`,
  ).toBeLessThanOrEqual(column.left + 1);
  // The column takes the body row's whole height, under the header and above
  // the Player, which keeps the frame's whole width with the tab bar.
  expect(column.top, `${label}: under the header`).toBeGreaterThanOrEqual(
    g.header!.bottom - 1,
  );
  const floor = g.player ? g.player.top : view.height - insets.bottom;
  expect(column.bottom, `${label}: down to the Player`).toBeGreaterThanOrEqual(
    floor - 2,
  );
  if (g.player)
    expect(
      g.player.width,
      `${label}: the Player keeps the whole width`,
    ).toBeCloseTo(view.width - (insets.left ?? 0) - insets.right, 0);
}

async function expectCloseWorks(page: Page, label: string) {
  const close = page
    .locator(".bottom-sheet--column")
    .getByRole("button", { name: "Close" });
  const center = await close.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      onScreen: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      reachable: !!top && (top === el || el.contains(top)),
    };
  });
  expect(center, `${label}: Close is on screen and not covered`).toEqual({
    onScreen: true,
    reachable: true,
  });
  await close.tap();
  await expect(page.locator(".bottom-sheet--column"), label).toHaveCount(0);
}

for (const [name, view] of Object.entries(COLUMN)) {
  test.describe(name, () => {
    test("a clip's Inspector is a column beside a whole timeline, and Close returns the shell", async ({
      page,
    }) => {
      await open(page, view, false);
      const before = await geometry(page);
      await page.locator(".clip-hit").first().tap();
      await inspectSelection(page);
      await expectColumn(page, view, name);
      // A toast centres over the timeline beside the column, not over it.
      const toastRight = await page.evaluate(() => {
        const region = document.createElement("div");
        region.className = "ui-toast-region--app";
        document.body.append(region);
        const right = region.getBoundingClientRect().right;
        region.remove();
        return right;
      });
      expect(
        toastRight,
        `${name}: the toast region stops at the column`,
      ).toBeLessThanOrEqual((await geometry(page)).column!.left);
      const after = await geometry(page);
      // The stage body takes the column's whole row: only width went to the
      // column, and the Player and tab bar are not in the way.
      expect(after.timeline!.width).toBeLessThan(before.timeline!.width);
      expect(
        Math.abs(after.body!.top - after.column!.top),
        `${name}: the stage body starts with the column`,
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(after.body!.bottom - after.column!.bottom),
        `${name}: the stage body ends with the column`,
      ).toBeLessThanOrEqual(2);
      // Its form is reachable by scrolling inside the column, not the page.
      const heading = page
        .locator(".bottom-sheet--column")
        .getByRole("heading", { name: "Inspector" });
      await expect(heading).toBeVisible();
      await expectCloseWorks(page, name);
      const closed = await geometry(page);
      expect(closed.player, `${name}: the Player stays`).not.toBeNull();
      expect(closed.timeline!.width).toBeCloseTo(before.timeline!.width, 0);
    });

    test("an envelope point's lane stays whole and uncovered beside the column", async ({
      page,
      context,
      browserName,
    }) => {
      await open(page, view, true);
      await selectEnvelopePoint({ page, context, browserName });
      await expectColumn(page, view, name);
      const g = await geometry(page);
      const point = await page
        .locator(
          `${lane} [data-hit-kind="envelope-point"][data-hit-id="env-c"]`,
        )
        .boundingBox();
      expect(point, `${name}: the selected point has a box`).not.toBeNull();
      expect(
        point!.x + point!.width,
        `${name}: the point is not under the column`,
      ).toBeLessThanOrEqual(g.column!.left + 1);
      const laneBox = await page.locator(lane).boundingBox();
      expect(
        laneBox!.y + laneBox!.height,
        `${name}: the lane is whole`,
      ).toBeLessThanOrEqual(g.timeline!.bottom + 1);
      await expectCloseWorks(page, name);
    });

    test("a pending edit's Approve and Reject float beside the column, not under it", async ({
      page,
      context,
      browserName,
    }) => {
      await open(page, view, false);
      const finger = await newFinger(context, page, browserName);
      await finger.down(
        await centerOf(page, `${lane} [data-pending-id] >> nth=0`),
      );
      await finger.up();
      await inspectSelectionByKey(page);
      await expectColumn(page, view, name);
      const bar = page.locator(".pending-actionbar");
      await expect(bar).toBeVisible();
      await expect(page.locator(".pending-actionbar--docked")).toHaveCount(0);
      const g = await geometry(page);
      const box = await bar.boundingBox();
      expect(
        box!.x + box!.width,
        `${name}: the card stops at the column`,
      ).toBeLessThanOrEqual(g.column!.left + 1);
      await expect(
        bar.getByRole("button", { name: "Approve", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    });

    test("with the keyboard up the column shortens to the visible viewport and keeps its header", async ({
      page,
      context,
      browserName,
    }) => {
      // Chromium can emulate the notch and home indicator; WebKit has no such
      // override, so its run checks the keyboard alone.
      const insets = { top: 0, bottom: 21, left: 47, right: 47 };
      if (browserName === "chromium") {
        const session = await context.newCDPSession(page);
        await session.send("Emulation.setDeviceMetricsOverride", {
          ...view,
          deviceScaleFactor: 1,
          mobile: true,
          screenWidth: view.width,
          screenHeight: view.height,
        });
        await session.send("Emulation.setSafeAreaInsetsOverride", { insets });
      }
      await open(page, view, false);
      await page.locator(".clip-hit").first().tap();
      await inspectSelection(page);
      await expectColumn(
        page,
        view,
        name,
        browserName === "chromium" ? insets : undefined,
      );
      const resting = await geometry(page);
      const keyboard = Math.round(view.height * 0.4);
      await setKeyboard(page, {
        top: 0,
        height: view.height - keyboard,
        inset: keyboard,
      });
      const g = await geometry(page);
      expect(
        g.position,
        `${name}: out of the flow while the keyboard is up`,
      ).toBe("fixed");
      expect(
        g.column!.bottom,
        `${name}: above the keyboard`,
      ).toBeLessThanOrEqual(view.height - keyboard + 1);
      expect(
        g.column!.top,
        `${name}: within the visible viewport`,
      ).toBeGreaterThanOrEqual(0);
      expect(g.column!.width, `${name}: the same width`).toBeCloseTo(
        resting.column!.width,
        0,
      );
      expect(
        g.timeline!.right,
        `${name}: the timeline does not move`,
      ).toBeCloseTo(resting.timeline!.right, 0);
      const close = page
        .locator(".bottom-sheet--column")
        .getByRole("button", { name: "Close" });
      await expect(close).toBeInViewport({ ratio: 1 });
      await setKeyboard(page, null);
      const back = await geometry(page);
      expect(back.position).toBe("relative");
      expect(back.column!.bottom).toBeCloseTo(resting.column!.bottom, 0);
      if (browserName === "chromium") {
        // The notch side and the home indicator stay clear, resting or typing.
        for (const [state, column] of [
          ["resting", resting.column!],
          ["typing", g.column!],
        ] as const) {
          expect(
            column.right,
            `${name} ${state}: clear of the notch side`,
          ).toBeLessThanOrEqual(view.width - insets.right + 1);
        }
        expect(
          resting.column!.bottom,
          `${name}: clear of the home indicator`,
        ).toBeLessThanOrEqual(view.height - insets.bottom + 1);
      }
    });
  });
}

test("with iOS's shrunk layout height the column is exactly the visible band, not the keyboard twice", async ({
  page,
}) => {
  // An iPhone 15 Plus on its real keypad reports innerHeight 249, a visual
  // viewport 122 tall at offsetTop 98 and a covered inset of 127. Fixed content
  // sits in that shrunk layout viewport, so subtracting the inset again left
  // a 21px column.
  const view = COLUMN["932x430 tablet shell"];
  await open(page, view, false);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  await expectColumn(page, view, "932x430");
  await page.setViewportSize({ width: view.width, height: 249 });
  await page.waitForFunction(() => innerHeight === 249);
  await settleViewport(page);
  await setKeyboard(page, { top: 98, height: 122, inset: 127 });
  await expect.poll(async () => (await geometry(page)).position).toBe("fixed");
  const g = await geometry(page);
  // A grid-area would make Safari resolve the offsets against the grid cell,
  // which put the column at the left edge and 52px low on an iPhone.
  expect(
    await page
      .locator(".bottom-sheet--column")
      .evaluate((el) => getComputedStyle(el).gridRowStart),
  ).toBe("auto");
  expect(g.column!.right).toBeLessThanOrEqual(view.width + 1);
  expect(g.column!.left).toBeGreaterThan(view.width / 2);
  expect(g.column!.top).toBeCloseTo(98, 0);
  expect(g.column!.height).toBeCloseTo(122, 0);
  expect(g.column!.bottom).toBeCloseTo(220, 0);
  const close = page
    .locator(".bottom-sheet--column")
    .getByRole("button", { name: "Close" });
  await expect(close).toBeInViewport({ ratio: 1 });
  await setKeyboard(page, null);
});

test("with Safari's chrome collapsed the column stops above the Player, not over the focused field", async ({
  page,
  context,
  browserName,
}) => {
  // An iPhone 15 Plus on its real keypad, chrome collapsed, reported innerHeight
  // 205 and a visual viewport 205 tall at offsetTop 142 with no inset, while
  // the frame stayed 347 tall: the band reaches the frame's bottom edge, where
  // the Player (above the home indicator) paints over a taller column.
  const view = COLUMN["932x430 tablet shell"];
  const insets = { top: 0, bottom: 21, left: 47, right: 47 };
  if (browserName === "chromium") {
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      ...view,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: view.width,
      screenHeight: view.height,
    });
    await session.send("Emulation.setSafeAreaInsetsOverride", { insets });
  }
  await open(page, view, false);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  await expectColumn(
    page,
    view,
    "932x430",
    browserName === "chromium" ? insets : undefined,
  );
  await page.setViewportSize({ width: view.width, height: 347 });
  await page.waitForFunction(() => innerHeight === 347);
  await settleViewport(page);
  const band = { top: 142, height: 205, inset: 0 };
  await setKeyboard(page, band);
  const field = page
    .locator(".bottom-sheet--column")
    .getByRole("spinbutton")
    .first();
  await field.focus();
  await field.scrollIntoViewIfNeeded();
  // Focusing and scrolling can fire the visual viewport's own scroll event,
  // and the keyboard hook clears a keyboard the device does not report. Put
  // the fake band back once those events have passed, so the geometry below
  // is read with the keyboard open on every engine and runner speed.
  await settleViewport(page);
  await setKeyboard(page, band);
  await expect.poll(async () => (await geometry(page)).position).toBe("fixed");
  const g = await geometry(page);
  const strip = g.player!;
  const box = (await field.boundingBox())!;
  const close = (await page
    .locator(".bottom-sheet--column")
    .getByRole("button", { name: "Close" })
    .boundingBox())!;
  expect(g.position).toBe("fixed");
  expect(g.column!.top, "starts at the visible band").toBeCloseTo(142, 0);
  expect(
    g.column!.bottom,
    "the column ends where the strip begins",
  ).toBeLessThanOrEqual(strip.top + 1);
  expect(
    box.y + box.height,
    "the focused field is clear of the strip",
  ).toBeLessThanOrEqual(strip.top + 1);
  expect(
    close.y + close.height,
    "Close is clear of the strip",
  ).toBeLessThanOrEqual(strip.top + 1);
  await setKeyboard(page, null);
});

for (const [name, view] of Object.entries(COLUMN).filter(
  ([, v]) => v.width !== 932,
)) {
  test.describe(name, () => {
    test("turning upright keeps an unsaved draft and its focus in the Inspector", async ({
      page,
    }) => {
      await open(page, view, false);
      await page.locator(".clip-hit").first().tap();
      await inspectSelection(page);
      await expectColumn(page, view, name);
      const level = page
        .locator(".bottom-sheet--column")
        .getByRole("spinbutton")
        .first();
      const typed = String(Number(await level.inputValue()) + 1);
      await level.fill(typed);
      await level.evaluate((el) => {
        (window as unknown as { __draft: Element }).__draft = el;
      });
      await expect(level).toBeFocused();
      await page.setViewportSize({ width: view.width, height: 700 });
      await expect(page.locator(".bottom-sheet--column")).toHaveCount(0);
      await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
      const kept = await page.evaluate(() => {
        const el = (window as unknown as { __draft: HTMLInputElement }).__draft;
        return {
          same: document.activeElement === el,
          connected: el.isConnected,
          value: el.value,
        };
      });
      expect(kept, `${name}: the same field, focused, with its draft`).toEqual({
        same: true,
        connected: true,
        value: typed,
      });
      await page.setViewportSize({ width: view.width, height: view.height });
      await expect(page.locator(".bottom-sheet--column")).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.activeElement ===
            (window as unknown as { __draft: Element }).__draft,
        ),
        `${name}: still the same focused field after turning back`,
      ).toBe(true);
      await expect(level).toHaveValue(typed);
    });
  });
}

for (const [name, view] of Object.entries(SHEET)) {
  test.describe(name, () => {
    test("the Inspector stays a bottom sheet", async ({ page }) => {
      await open(page, view, false);
      await page.locator(".clip-hit").first().tap();
      await inspectSelection(page);
      await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
      const g = await geometry(page);
      expect(g.column).toBeNull();
      expect(g.sheetRoot).toBe(true);
    });
  });
}

test("rotating a phone from portrait to landscape moves the open Inspector into a column and back", async ({
  page,
}) => {
  const portrait = { width: 390, height: 844, shell: "phone" } as const;
  const landscape = COLUMN["844x390 tablet shell"];
  await open(page, portrait, false);
  await page.locator(".clip-hit").first().tap();
  await inspectSelection(page);
  await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
  await page.setViewportSize(landscape);
  await expect(page.locator(".bottom-sheet--column")).toBeVisible();
  await expect(page.locator(".bottom-sheet-root")).toHaveCount(0);
  await page.setViewportSize(portrait);
  await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
  await expect(page.locator(".bottom-sheet--column")).toHaveCount(0);
});
