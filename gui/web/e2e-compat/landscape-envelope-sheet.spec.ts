import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { repoRoot } from "../e2e/env";
import {
  addEnvelopePoint,
  inspectEnvelopePoint,
  openEnvelopeTrackDetails,
  pointSheet,
  setPointField,
  showEnvelope,
} from "../e2e/envelopeCreationEvidence";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

/*
 * #1694 a phone held sideways (the short tablet shell) editing a volume
 * envelope point: the lane being edited, the ruler above it and the point's
 * Time and Level all stay on screen, Remove stays reachable with and without
 * the software keyboard, and the open point survives a rotation.
 * Playwright cannot emulate iOS safe-area insets or a real software keypad;
 * the keyboard is the `--keyboard-inset` the sheet reads from useKeyboardInset.
 */

test.use({ hasTouch: true, isMobile: true });

type Viewport = { width: number; height: number; keyboard: number };
const VIEWPORTS: Viewport[] = [
  { width: 932, height: 430, keyboard: 170 },
  { width: 914, height: 331, keyboard: 130 },
];
/** The floating card does not shrink the timeline; the lane edge may sit under its border. */
const LANE_SLACK_PX = 2;
const TRACK = "Extra voice 1";
const TRACK_INDEX = 2;

async function seed(page: Page, projectPath: string) {
  for (let i = 1; i <= 3; i++)
    await postDocumentCommand(
      page,
      "e2e-landscape-envelope",
      "AddTrack",
      { label: `Extra voice ${i}` },
      projectPath,
    );
  await expect(page.locator(".lane-row")).toHaveCount(5);
}

async function openEnvelope(page: Page) {
  await openEnvelopeTrackDetails(page, TRACK, []);
  await showEnvelope(page);
  await expect(
    page.getByRole("button", { name: "Hide volume envelope", exact: true }),
  ).toBeVisible();
}

async function openPoint(page: Page) {
  await openEnvelope(page);
  await addEnvelopePoint(page, {
    lane: page.locator(".lane-row").nth(TRACK_INDEX),
  });
  await inspectEnvelopePoint(page);
}

const field = (page: Page, name: "Time" | "Level") =>
  pointSheet(page).getByRole("spinbutton", { name, exact: true });
const remove = (page: Page) =>
  pointSheet(page).getByRole("button", { name: /^Remove/ });

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

/** Visible height of lane `index` between the pinned ruler and the sheet. */
function laneBand(page: Page, index: number) {
  return page.evaluate((i) => {
    const lane = document
      .querySelectorAll(".lane-row")
      [i]!.getBoundingClientRect();
    const ruler = document
      .querySelector(".marker-lane")!
      .getBoundingClientRect();
    const limit = document
      .querySelector(".timeline-scroll")!
      .getBoundingClientRect().bottom;
    const top = Math.max(lane.top, ruler.bottom);
    const bottom = Math.min(lane.bottom, limit);
    return {
      laneHeight: Math.round(lane.height),
      visible: Math.round(Math.max(0, bottom - top)),
      rulerBottom: Math.round(ruler.bottom),
    };
  }, index);
}

/**
 * Does `control` sit wholly inside the sheet's visible area and the viewport?
 * A column's body scrolls like any form, so a control in one is first
 * scrolled into the column (#1696); a sheet's controls must already be there.
 */
async function expectInSheet(control: Locator, label: string) {
  await control.scrollIntoViewIfNeeded();
  const geometry = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const sheet = el.closest(".sys-inspector")!.getBoundingClientRect();
    const slot = undefined as DOMRect | undefined;
    let top = Math.max(sheet.top, slot?.top ?? 0, 0);
    let bottom = Math.min(
      sheet.bottom,
      slot?.bottom ?? innerHeight,
      innerHeight,
    );
    for (
      let parent = el.parentElement;
      parent && parent !== el.closest(".sys-inspector")!.parentElement;
      parent = parent.parentElement
    ) {
      if (getComputedStyle(parent).overflowY === "visible") continue;
      const clip = parent.getBoundingClientRect();
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
    return {
      r: { top: r.top, bottom: r.bottom, height: r.height },
      top,
      bottom,
    };
  });
  expect(geometry.r.height, `${label} has a box`).toBeGreaterThan(0);
  expect(geometry.r.top, `${label} top`).toBeGreaterThanOrEqual(
    geometry.top - 0.5,
  );
  expect(geometry.r.bottom, `${label} bottom`).toBeLessThanOrEqual(
    geometry.bottom + 0.5,
  );
}

async function editedLaneInReach(page: Page, vp: Viewport) {
  await page.setViewportSize(vp);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await openPoint(page);

    const band = await laneBand(page, TRACK_INDEX);
    expect(band.visible).toBeGreaterThanOrEqual(
      band.laneHeight - LANE_SLACK_PX,
    );
    await expectInSheet(field(page, "Time"), "Time");
    await expectInSheet(remove(page), "Remove");
  });
}

async function fieldsInReach(page: Page, vp: Viewport) {
  await page.setViewportSize(vp);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await openPoint(page);

    const time = field(page, "Time");
    const level = field(page, "Level");
    const band = await laneBand(page, TRACK_INDEX);
    expect(band.visible).toBeGreaterThanOrEqual(
      band.laneHeight - LANE_SLACK_PX,
    );
    for (const [control, label] of [
      [time, "Time"],
      [level, "Level"],
      [remove(page), "Remove"],
    ] as const)
      await expectInSheet(control, label);

    await setKeyboard(page, vp.keyboard);
    await level.focus();
    for (const [control, label] of [
      [time, "Time"],
      [level, "Level"],
      [remove(page), "Remove"],
    ] as const)
      await expectInSheet(control, `${label} with keyboard`);
    const close = pointSheet(page).getByRole("button", { name: "Close" });
    await close.scrollIntoViewIfNeeded();
    await expectInSheet(close, "Close with keyboard");
  });
}

async function fieldsRun(page: Page, vp: Viewport) {
  await page.setViewportSize(vp);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await openPoint(page);
    await setPointField(page, "Level", "0.5");
    await expect(field(page, "Level")).toHaveAttribute("aria-valuenow", "0.5");
    await remove(page).tap();
    await expect(field(page, "Level")).toHaveCount(0);
  });
}

test("932x430: the edited lane stays beside the card and Time and Remove are in reach", async ({
  page,
}) => {
  await editedLaneInReach(page, VIEWPORTS[0]!);
});

test("932x430: Time, Level and Remove are visible with the lane, and with the keyboard up", async ({
  page,
}) => {
  await fieldsInReach(page, VIEWPORTS[0]!);
});

test("932x430: Level and Remove run from inside the sheet", async ({
  page,
}) => {
  await fieldsRun(page, VIEWPORTS[0]!);
});

test("914x331: the edited lane stays beside the card and Time and Remove are in reach", async ({
  page,
}) => {
  await editedLaneInReach(page, VIEWPORTS[1]!);
});

test("914x331: Time, Level and Remove are visible with the lane, and with the keyboard up", async ({
  page,
}) => {
  await fieldsInReach(page, VIEWPORTS[1]!);
});

test("914x331: Level and Remove run from inside the sheet", async ({
  page,
}) => {
  await fieldsRun(page, VIEWPORTS[1]!);
});

test("an open envelope point survives rotating from portrait to landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await rememberInspectorDetent(page, "half");
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await openPhoneTimeline(page);
    await seed(page, projectPath);
    await openPoint(page);
    await setPointField(page, "Level", "0.25");
    await expect(field(page, "Level")).toHaveAttribute("aria-valuenow", "0.25");

    await page.setViewportSize({ width: 932, height: 430 });
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await expect(field(page, "Level")).toHaveAttribute("aria-valuenow", "0.25");

    await page.setViewportSize({ width: 430, height: 932 });
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(field(page, "Level")).toHaveAttribute("aria-valuenow", "0.25");
  });
});

const DEMO_ROOT = path.join(repoRoot, "tests/fixtures/sharecut_ux_demo");
const DEMO_TRACK = "guest";

/** The demo project has chapter, comment and social marker rows above its lanes. */
function withDemoProject(fn: (projectPath: string) => Promise<void>) {
  return withShareableProject(fn, undefined, (prefix) =>
    createRelocatedE2eProject(prefix, undefined, DEMO_ROOT),
  );
}
async function fieldLayout(
  page: Page,
  vp: { width: number; height: number },
  shell: "tablet" | "phone" = "tablet",
) {
  await page.setViewportSize(vp);
  return withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(`.stage-frame--${shell}`)).toBeVisible();
    if (shell === "phone") await openPhoneTimeline(page);
    await seed(page, projectPath);
    await openPoint(page);
    const time = await field(page, "Time").boundingBox();
    const level = await field(page, "Level").boundingBox();
    const help = await pointSheet(page)
      .getByText(/^Level multiplies this track/)
      .boundingBox();
    return {
      oneRow: Math.abs(time!.y - level!.y) < 1,
      helpHeight: help?.height ?? 0,
    };
  });
}

test("1194x834 iPad landscape keeps Time and Level stacked with their visible help", async ({
  page,
}) => {
  const layout = await fieldLayout(page, { width: 1194, height: 834 });
  expect(layout.oneRow).toBe(false);
  expect(layout.helpHeight).toBeGreaterThan(8);
});

test("932x430 phone landscape keeps Time and Level stacked with their help, in the Inspector card", async ({
  page,
}) => {
  const layout = await fieldLayout(page, { width: 932, height: 430 });
  expect(layout.oneRow).toBe(false);
  expect(layout.helpHeight).toBeGreaterThan(8);
});

test("914x331 idle: a touch tap on the guest track header opens its details and reaches Show volume envelope", async ({
  page,
}) => {
  await page.setViewportSize({ width: 914, height: 331 });
  await withDemoProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    const header = page.getByRole("button", {
      name: `Open track details, ${DEMO_TRACK}`,
      exact: true,
    });
    await header.scrollIntoViewIfNeeded();
    const point = await header.evaluate((el) => {
      const title = el
        .closest(".track-header-row")!
        .querySelector(".track-title, .track-chip")!
        .getBoundingClientRect();
      const x = title.left + title.width / 2;
      const y = title.top + title.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        onScreen: y > 0 && y < innerHeight,
        hitsHeader: hit === el || (hit !== null && el.contains(hit)),
      };
    });
    expect(point.onScreen, "the guest name is on screen").toBe(true);
    expect(
      point.hitsHeader,
      "a touch on the guest name reaches the header",
    ).toBe(true);
    await page.touchscreen.tap(point.x, point.y);
    await expect(
      page.getByRole("button", { name: "Show volume envelope", exact: true }),
    ).toBeVisible();
  });
});

async function expectIdleMarkerPosition(
  page: Page,
  vp: { width: number; height: number },
  expected: "sticky" | "relative",
  shell: "tablet" | "phone" = "tablet",
) {
  await page.setViewportSize(vp);
  await withDemoProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(`.stage-frame--${shell}`)).toBeVisible();
    if (shell === "phone") await openPhoneTimeline(page);
    const position = await page
      .locator(".marker-lane")
      .evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe(expected);
  });
}

test("667x375 phone shell idle: the marker rows scroll with the lanes", async ({
  page,
}) => {
  await expectIdleMarkerPosition(
    page,
    { width: 667, height: 375 },
    "relative",
    "phone",
  );
});

test("667x500 phone shell idle: the marker rows stay pinned under the ruler", async ({
  page,
}) => {
  await expectIdleMarkerPosition(
    page,
    { width: 667, height: 500 },
    "sticky",
    "phone",
  );
});

test("914x331 idle: the marker rows scroll with the lanes", async ({
  page,
}) => {
  await expectIdleMarkerPosition(page, { width: 914, height: 331 }, "relative");
});

test("932x430 idle: the marker rows stay pinned under the ruler", async ({
  page,
}) => {
  await expectIdleMarkerPosition(page, { width: 932, height: 430 }, "sticky");
});

test("1194x834 idle: the marker rows stay pinned under the ruler", async ({
  page,
}) => {
  await expectIdleMarkerPosition(page, { width: 1194, height: 834 }, "sticky");
});

test("1024x768 idle: the marker rows stay pinned under the ruler", async ({
  page,
}) => {
  await expectIdleMarkerPosition(page, { width: 1024, height: 768 }, "sticky");
});

test("a soloed track keeps Clear solo tappable at the top of the timeline at 914x331 while the envelope sheet is open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 914, height: 331 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await page
      .getByRole("button", { name: `Solo ${TRACK}`, exact: true })
      .tap();
    await expect(page.locator(".solo-chip")).toBeVisible();
    await openEnvelope(page);
    const chip = page.locator(".solo-chip");
    await page.locator(".timeline-scroll").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(chip).toBeInViewport();
    const hit = await chip.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return !!top && (top === el || el.contains(top));
    });
    expect(hit, "Clear solo is not covered").toBe(true);
  });
});
