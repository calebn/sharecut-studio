import { expect, type Locator, type Page, test } from "@playwright/test";
import { postDocumentCommand } from "../e2e/documentCommand";
import { openEnvelopeTrackDetails } from "../e2e/envelopeCreationEvidence";
import { openPhoneTimeline } from "../e2e/phoneTimeline";
import { withShareableProject } from "../e2e/shareableProject";

/*
 * #1694 a phone held sideways (the short tablet shell) editing a volume
 * envelope: the lane being edited, the ruler above it and the entry form all
 * stay on screen, Add point, Done, Save and Cancel stay reachable with and
 * without the software keyboard, and a typed draft survives a rotation.
 * Playwright cannot emulate iOS safe-area insets or a real software keypad;
 * the keyboard is the `--keyboard-inset` the sheet reads from useKeyboardInset.
 */

test.use({ hasTouch: true, isMobile: true });

const VIEWPORTS = [
  { width: 932, height: 430, keyboard: 170 },
  { width: 914, height: 331, keyboard: 130 },
];
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
    const sheet = document
      .querySelector(".bottom-sheet")!
      .getBoundingClientRect();
    const top = Math.max(lane.top, ruler.bottom);
    const bottom = Math.min(lane.bottom, sheet.top);
    return {
      laneHeight: Math.round(lane.height),
      visible: Math.round(Math.max(0, bottom - top)),
      rulerBottom: Math.round(ruler.bottom),
    };
  }, index);
}

/** Does `control` sit wholly inside the sheet's visible area and the viewport? */
async function expectInSheet(page: Page, control: Locator, label: string) {
  const geometry = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const sheet = el.closest(".bottom-sheet")!.getBoundingClientRect();
    const slot = el.closest(".bottom-sheet-root")!.getBoundingClientRect();
    return {
      r: { top: r.top, bottom: r.bottom, height: r.height },
      top: Math.max(sheet.top, slot.top, 0),
      bottom: Math.min(sheet.bottom, slot.bottom, innerHeight),
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

for (const vp of VIEWPORTS) {
  const size = `${vp.width}x${vp.height}`;

  test(`${size}: the edited lane stays above the sheet and Add point and Done are in reach`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await expect(page.locator(".daw-shell--tablet")).toBeVisible();
      await seed(page, projectPath);
      await openEnvelope(page);

      await expect(page.locator(".bottom-tabs")).toBeHidden();
      const band = await laneBand(page, TRACK_INDEX);
      expect(band.visible).toBe(band.laneHeight);
      await expectInSheet(
        page,
        page.getByRole("button", { name: "Add point", exact: true }),
        "Add point",
      );
      await expectInSheet(
        page,
        page.getByRole("button", { name: "Done", exact: true }),
        "Done",
      );
    });
  });

  test(`${size}: the form, Save and Cancel are visible with the lane, and with the keyboard up`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await expect(page.locator(".daw-shell--tablet")).toBeVisible();
      await seed(page, projectPath);
      await openEnvelope(page);
      await page.getByRole("button", { name: "Add point", exact: true }).tap();

      const time = page.getByLabel("Time (seconds on timeline)");
      const level = page.getByLabel("Level (×)");
      const save = page.getByRole("button", { name: "Save point" });
      const cancel = page
        .locator(".bottom-sheet")
        .getByRole("button", { name: "Cancel" });
      const band = await laneBand(page, TRACK_INDEX);
      expect(band.visible).toBe(band.laneHeight);
      for (const [control, label] of [
        [time, "Time"],
        [level, "Level"],
        [save, "Save point"],
        [cancel, "Cancel"],
      ] as const)
        await expectInSheet(page, control, label);

      await setKeyboard(page, vp.keyboard);
      await level.focus();
      for (const [control, label] of [
        [time, "Time"],
        [level, "Level"],
        [save, "Save point"],
        [cancel, "Cancel"],
      ] as const)
        await expectInSheet(page, control, `${label} with keyboard`);
      const done = page.getByRole("button", { name: "Done", exact: true });
      await done.scrollIntoViewIfNeeded();
      await expectInSheet(page, done, "Done with keyboard");
    });
  });

  test(`${size}: Add point, Save and Cancel run from inside the sheet`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await withShareableProject(async (projectPath) => {
      await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
      await expect(page.locator(".daw-shell--tablet")).toBeVisible();
      await seed(page, projectPath);
      await openEnvelope(page);
      await page.getByRole("button", { name: "Add point", exact: true }).tap();
      await page
        .locator(".bottom-sheet")
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
  });
}

test("a typed envelope draft survives rotating from portrait to landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await openPhoneTimeline(page);
    await seed(page, projectPath);
    await openEnvelope(page);
    await page.getByRole("button", { name: "Add point", exact: true }).tap();
    await page.getByLabel("Time (seconds on timeline)").fill("7");
    await page.getByLabel("Level (×)").fill("0.25");

    await page.setViewportSize({ width: 932, height: 430 });
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    await expect(page.getByLabel("Time (seconds on timeline)")).toHaveValue(
      "7",
    );
    await expect(page.getByLabel("Level (×)")).toHaveValue("0.25");

    await page.setViewportSize({ width: 430, height: 932 });
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    await expect(page.getByLabel("Level (×)")).toHaveValue("0.25");
  });
});

test("the bottom panel splitter can shrink a short window's default panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 914, height: 331 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(page.locator(".daw-shell--tablet")).toBeVisible();
    const separator = page.getByRole("separator").first();
    await expect(separator).toBeVisible();
    const tabs = page.locator(".bottom-tabs");
    const before = (await tabs.boundingBox())!.height;
    const min = Number(await separator.getAttribute("aria-valuemin"));
    const rem = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(min * rem).toBeLessThanOrEqual(before + 0.5);
    await separator.focus();
    await page.keyboard.press("ArrowDown");
    const after = (await tabs.boundingBox())!.height;
    expect(after).toBeLessThan(before);
  });
});
