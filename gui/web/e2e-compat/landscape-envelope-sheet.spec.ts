import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { repoRoot } from "../e2e/env";
import { openEnvelopeTrackDetails } from "../e2e/envelopeCreationEvidence";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject } from "../e2e/stageNav";

/*
 * #1694 a phone held sideways (the short tablet shell) editing a volume
 * envelope: the lane being edited, the ruler above it and the entry form all
 * stay on screen, Add point, Done, Save and Cancel stay reachable with and
 * without the software keyboard, and a typed draft survives a rotation.
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
  await page
    .getByRole("button", { name: "Add volume envelope", exact: true })
    .tap();
  await page
    .getByRole("button", { name: "Show volume envelope", exact: true })
    .tap();
  await expect(
    page.getByRole("button", { name: "Hide volume envelope", exact: true }),
  ).toBeVisible();
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
    await openEnvelope(page);

    const band = await laneBand(page, TRACK_INDEX);
    expect(band.visible).toBeGreaterThanOrEqual(
      band.laneHeight - LANE_SLACK_PX,
    );
    await expectInSheet(
      page.getByRole("button", { name: "Add point", exact: true }),
      "Add point",
    );
    await expectInSheet(
      page.getByRole("button", { name: "Done", exact: true }),
      "Done",
    );
  });
}

async function formInReach(page: Page, vp: Viewport) {
  await page.setViewportSize(vp);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await openEnvelope(page);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();

    const time = page.getByLabel("Time (seconds on timeline)");
    const level = page.getByLabel("Level (×)");
    const save = page.getByRole("button", { name: "Save point" });
    const cancel = page
      .locator(".sys-inspector")
      .getByRole("button", { name: "Cancel" });
    const band = await laneBand(page, TRACK_INDEX);
    expect(band.visible).toBeGreaterThanOrEqual(
      band.laneHeight - LANE_SLACK_PX,
    );
    for (const [control, label] of [
      [time, "Time"],
      [level, "Level"],
      [save, "Save point"],
      [cancel, "Cancel"],
    ] as const)
      await expectInSheet(control, label);

    await setKeyboard(page, vp.keyboard);
    await level.focus();
    for (const [control, label] of [
      [time, "Time"],
      [level, "Level"],
      [save, "Save point"],
      [cancel, "Cancel"],
    ] as const)
      await expectInSheet(control, `${label} with keyboard`);
    const done = page.getByRole("button", { name: "Done", exact: true });
    await done.scrollIntoViewIfNeeded();
    await expectInSheet(done, "Done with keyboard");
  });
}

async function formRuns(page: Page, vp: Viewport) {
  await page.setViewportSize(vp);
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await seed(page, projectPath);
    await openEnvelope(page);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();
    await page
      .locator(".sys-inspector")
      .getByRole("button", { name: "Cancel" })
      .tap();
    await expect(page.getByLabel("Level (×)")).toHaveCount(0);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();
    await page.getByLabel("Level (×)").fill("0.5");
    await page.getByRole("button", { name: "Save point" }).tap();
    await expect(page.getByLabel("Level (×)")).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: /Envelope point/ }),
    ).toBeVisible();
  });
}

test("932x430: the edited lane stays above the sheet and Add point and Done are in reach", async ({
  page,
}) => {
  await editedLaneInReach(page, VIEWPORTS[0]!);
});

test("932x430: the form, Save and Cancel are visible with the lane, and with the keyboard up", async ({
  page,
}) => {
  await formInReach(page, VIEWPORTS[0]!);
});

test("932x430: Add point, Save and Cancel run from inside the sheet", async ({
  page,
}) => {
  await formRuns(page, VIEWPORTS[0]!);
});

test("914x331: the edited lane stays above the sheet and Add point and Done are in reach", async ({
  page,
}) => {
  await editedLaneInReach(page, VIEWPORTS[1]!);
});

test("914x331: the form, Save and Cancel are visible with the lane, and with the keyboard up", async ({
  page,
}) => {
  await formInReach(page, VIEWPORTS[1]!);
});

test("914x331: Add point, Save and Cancel run from inside the sheet", async ({
  page,
}) => {
  await formRuns(page, VIEWPORTS[1]!);
});

test("a typed envelope draft survives rotating from portrait to landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await openPhoneTimeline(page);
    await seed(page, projectPath);
    await openEnvelope(page);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();
    await page.getByLabel("Time (seconds on timeline)").fill("7");
    await page.getByLabel("Level (×)").fill("0.25");

    await page.setViewportSize({ width: 932, height: 430 });
    await expect(page.locator(".stage-frame--tablet")).toBeVisible();
    await expect(page.getByLabel("Time (seconds on timeline)")).toHaveValue(
      "7",
    );
    await expect(page.getByLabel("Level (×)")).toHaveValue("0.25");

    await page.setViewportSize({ width: 430, height: 932 });
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(page.getByLabel("Level (×)")).toHaveValue("0.25");
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
async function formLayout(
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
    await openEnvelope(page);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();
    const time = await page
      .getByLabel("Time (seconds on timeline)")
      .boundingBox();
    const level = await page.getByLabel("Level (×)").boundingBox();
    const help = await page
      .getByText(/^Time is measured on the timeline/)
      .boundingBox();
    return {
      oneRow: Math.abs(time!.y - level!.y) < 1,
      helpHeight: help?.height ?? 0,
    };
  });
}

test("1194x834 iPad landscape keeps the regular envelope form and its visible help", async ({
  page,
}) => {
  const layout = await formLayout(page, { width: 1194, height: 834 });
  expect(layout.oneRow).toBe(false);
  expect(layout.helpHeight).toBeGreaterThan(8);
});

test("932x430 phone landscape keeps the regular stacked form and its help, in the Inspector card", async ({
  page,
}) => {
  const layout = await formLayout(page, { width: 932, height: 430 });
  expect(layout.oneRow).toBe(false);
  expect(layout.helpHeight).toBeGreaterThan(8);
});

test("914x331 idle: a touch tap on the guest track header opens its details and reaches Add volume envelope", async ({
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
      page.getByRole("button", { name: "Add volume envelope", exact: true }),
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
