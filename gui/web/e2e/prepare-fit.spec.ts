import { expect, type Page, test } from "@playwright/test";
import type { PipelineJobSnapshot } from "../src/types/pipeline";
import { expectSurfaceAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { expectNoHorizontalScroll } from "./modelsMock";
import { setRootFontSize } from "./rootFontSize";
import { openProject } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

const LONG_FILE = `recording_${"abcdefghij".repeat(12)}.wav`;
const LONG_ERROR = `Could not write ${LONG_FILE}: permission denied`;
const LONG_MODEL_PATH =
  "/very-long-project-directory-name/with-a-deeply-nested-model-cache/word-timing-model-weights.bin";
const LONG_MODEL_LABEL = `Word-timing-model-for-${"languages-with-long-names-".repeat(4)}weights`;

function failedJob(
  id: string,
  error: string,
  extra: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id,
    project_path: e2eProjectPath,
    from_step: null,
    only_step: null,
    kind: "pipeline",
    status: "error",
    current: 2,
    total: 3,
    message: "Pipeline failed",
    error,
    elapsed_sec: 3,
    steps: [
      {
        name: "ingest_tracks",
        status: "ok",
        elapsed_sec: 1,
        error: null,
        summary: "2 tracks ingested",
      },
      {
        name: "transcribe_tracks",
        status: "error",
        elapsed_sec: 2,
        error,
        summary: "This summary must yield to the error",
      },
    ],
    ...extra,
  };
}

async function openPrepare(
  page: Page,
  job: PipelineJobSnapshot | null,
): Promise<void> {
  await page.route("**/api/pipeline/status", (route) =>
    route.fulfill({
      json: {
        running: false,
        job,
        jobs: job ? [job] : [],
        running_count: 0,
      },
    }),
  );
  await openProject(page, e2eProjectPath, { stage: "prepare" });
  await expect(page.locator(".sys-prepare")).toBeVisible();
}

async function textFits(page: Page, selector: string): Promise<void> {
  const widths = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent,
      client: element.clientWidth,
      scroll: element.scrollWidth,
    })),
  );
  expect(widths.length).toBeGreaterThan(0);
  for (const { text, client, scroll } of widths) {
    expect(scroll, text ?? "").toBeLessThanOrEqual(client + 1);
  }
}

test.use({ hasTouch: true });

const CELLS = [320, 390, 1440].flatMap((width) =>
  [16, 32].map((rootFont) => ({
    viewport: { width, height: width < 768 ? 700 : 900 },
    rootFont,
  })),
);

for (const { cell, theme } of withAppearance(CELLS)) {
  const { viewport, rootFont } = cell;
  test(`Prepare toolbar fit: terms field and hand-off stay reachable at ${viewport.width}px, root ${rootFont}px, ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openPrepare(page, null);
    await setTheme(page, theme);
    await setRootFontSize(page, rootFont);
    const terms = page.getByLabel("Names and terms", { exact: true });
    const handoff = page.locator(".sys-handoff");
    await terms.scrollIntoViewIfNeeded();
    await expect(terms).toBeInViewport();
    await handoff.scrollIntoViewIfNeeded();
    await expect(handoff).toBeInViewport();
    await expectNoHorizontalScroll(page);
    for (const control of [terms, handoff]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  });
}

for (const { cell, theme } of withAppearance(
  [320, 390, 1440].map((width) => ({ width, height: 800 })),
  1,
)) {
  test(`Prepare results fit: a failed row wraps a long error at ${cell.width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize(cell);
    await openPrepare(page, failedJob("fit-error", LONG_ERROR));
    await setTheme(page, theme);
    const rows = page.getByRole("list", { name: "Getting ready" });
    const details = rows.getByRole("button", {
      name: "Details for Transcribe",
    });
    await expect(details).toBeVisible();
    await details.click();
    const cause = rows.locator(".sys-status-cause");
    await expect(cause).toHaveText(LONG_ERROR);
    await expect(rows.locator(".sys-status-detail").first()).toBeVisible();
    await textFits(page, ".sys-prepare .sys-status-detail");
    await textFits(page, ".sys-prepare .sys-status-cause");
    await expectNoHorizontalScroll(page);
    await expectSurfaceAxeClean(page, ".sys-prepare-ready");
  });
}

test("Prepare warning layout: a missing-model banner with a long name wraps at 768px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openPrepare(
    page,
    failedJob("fit-model", `Model not found at ${LONG_MODEL_PATH}`, {
      error_code: "model_needed",
      error_model: {
        id: "word-timing",
        label: LONG_MODEL_LABEL,
        size: "~120 MB",
        state: "missing",
      },
    }),
  );
  const banner = page.locator(".guest-banner", {
    hasText: "is not downloaded.",
  });
  await expect(banner).toContainText(LONG_MODEL_LABEL);
  await expect(banner).toBeInViewport();
  const box = (await banner.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(768 + 1);
  await textFits(page, ".guest-banner");
  await expectNoHorizontalScroll(page);
});
