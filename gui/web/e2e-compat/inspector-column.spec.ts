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
  buildFixture,
  type CaseFixtures,
  centerOf,
  lane,
  setZoom,
} from "../e2e/touchTimeline";

/*
 * #1696 a phone held sideways (a coarse pointer, at most 40rem tall and at
 * least 40rem wide) shows the selection Inspector as a column on the inline
 * end of the shell, not a bottom sheet: the timeline keeps the whole main row
 * beside it, and the tabs row or mode nav gives way. Narrower or taller
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
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await buildFixture(page, projectPath, CLIENT_ID);
  await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
  await expect(page.locator(`.daw-shell--${view.shell}`)).toBeVisible();
  if (view.shell === "phone") await openPhoneTimeline(page);
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
  await page.waitForTimeout(60);
  await finger.up();
}

async function setKeyboard(page: Page, px: number | null) {
  await page.evaluate((inset) => {
    const root = document.documentElement;
    if (inset === null) {
      delete root.dataset.keyboard;
      root.style.removeProperty("--keyboard-inset");
      root.style.removeProperty("--visual-viewport-top");
    } else {
      root.dataset.keyboard = "open";
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      root.style.setProperty("--visual-viewport-top", "0px");
    }
  }, px);
}

/** The column's place, the timeline's, and what the shell hid for it. */
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
    const shell = document.querySelector(".daw-shell");
    const column = document.querySelector(".bottom-sheet--column");
    const hidden = (selector: string) => {
      const el = document.querySelector(selector);
      return !el || getComputedStyle(el).display === "none";
    };
    return {
      inGrid: column?.parentElement === shell,
      shellClass: shell?.className ?? "",
      column: box(column),
      position: column ? getComputedStyle(column).position : null,
      timeline: box(document.querySelector(".timeline-scroll")),
      transport: box(document.querySelector(".daw-shell-transport")),
      status: box(document.querySelector(".status-bar")),
      sheetRoot: document.querySelector(".bottom-sheet-root") !== null,
      compact: document.querySelector(".bottom-sheet--compact") !== null,
      scrim: document.querySelector(".bottom-sheet-scrim") !== null,
      resize:
        column?.querySelector(
          ".bottom-sheet-resize-action, .bottom-sheet-detent",
        ) != null,
      tabsHidden: hidden(".bottom-tabs"),
      navHidden: hidden(".mobile-nav"),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
}

async function expectColumn(page: Page, view: Layout, label: string) {
  await expect(page.locator(".bottom-sheet--column"), label).toBeVisible();
  const g = await geometry(page);
  const column = g.column!;
  expect(g.inGrid, `${label}: a child of the shell grid`).toBe(true);
  expect(g.shellClass, label).toContain("daw-shell--inspector-column");
  expect(g.sheetRoot, `${label}: nothing portaled`).toBe(false);
  expect(g.compact, `${label}: no compact strip`).toBe(false);
  expect(g.scrim, `${label}: no scrim`).toBe(false);
  expect(g.resize, `${label}: no drawer or resize controls`).toBe(false);
  expect(column.right, `${label}: on the inline end`).toBeCloseTo(
    view.width,
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
  // The column takes the main row's whole height, under the transport and
  // above the status line (tablet) or the screen's end (phone).
  expect(column.top, `${label}: under the transport`).toBeGreaterThanOrEqual(
    g.transport!.bottom - 1,
  );
  const floor = g.status ? g.status.top : view.height;
  expect(
    column.bottom,
    `${label}: down to the status row`,
  ).toBeGreaterThanOrEqual(floor - 2);
  expect(
    view.shell === "tablet" ? g.tabsHidden : g.navHidden,
    `${label}: the tabs row or the mode nav gives way`,
  ).toBe(true);
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
  await expect(page.locator(".daw-shell"), label).not.toHaveClass(
    /daw-shell--inspector-column/,
  );
}

for (const [name, view] of Object.entries(COLUMN)) {
  test.describe(name, () => {
    test("a clip's Inspector is a column beside a whole timeline, and Close returns the shell", async ({
      page,
    }) => {
      await open(page, view, false);
      const before = await geometry(page);
      await page.locator(".clip-hit").first().tap();
      await expectColumn(page, view, name);
      const after = await geometry(page);
      // The timeline keeps its height; only the column took width.
      expect(
        after.timeline!.height,
        `${name}: timeline height`,
      ).toBeGreaterThanOrEqual(before.timeline!.height - 1);
      expect(after.timeline!.width).toBeLessThan(before.timeline!.width);
      // Its form is reachable by scrolling inside the column, not the page.
      const heading = page
        .locator(".bottom-sheet--column")
        .getByRole("heading", { name: "Inspector" });
      await expect(heading).toBeVisible();
      await expectCloseWorks(page, name);
      const closed = await geometry(page);
      expect(closed.tabsHidden && closed.navHidden).toBe(false);
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
      await expectColumn(page, view, name);
      const resting = await geometry(page);
      const keyboard = Math.round(view.height * 0.4);
      await setKeyboard(page, keyboard);
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

for (const [name, view] of Object.entries(SHEET)) {
  test.describe(name, () => {
    test("the Inspector stays a bottom sheet", async ({ page }) => {
      await open(page, view, false);
      await page.locator(".clip-hit").first().tap();
      await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
      const g = await geometry(page);
      expect(g.column).toBeNull();
      expect(g.sheetRoot).toBe(true);
      expect(g.shellClass).not.toContain("daw-shell--inspector-column");
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
  await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
  await page.setViewportSize(landscape);
  await expect(page.locator(".bottom-sheet--column")).toBeVisible();
  await expect(page.locator(".bottom-sheet-root")).toHaveCount(0);
  await page.setViewportSize(portrait);
  await expect(page.locator(".bottom-sheet--inspector")).toBeVisible();
  await expect(page.locator(".bottom-sheet--column")).toHaveCount(0);
});
