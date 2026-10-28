import { expect, test } from "@playwright/test";
import type { PipelineJobSnapshot } from "../src/types/pipeline";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import { withAppearance } from "./theme";

const job: PipelineJobSnapshot = {
  id: "prepare-progress",
  project_path: e2eProjectPath,
  from_step: null,
  only_step: null,
  kind: "pipeline",
  status: "running",
  current: 1,
  total: 3,
  message: "Transcribing",
  error: null,
  elapsed_sec: 4,
  steps: [
    {
      name: "ingest_tracks",
      status: "ok",
      elapsed_sec: 1,
      error: null,
      summary: null,
    },
    {
      name: "transcribe_tracks",
      status: "running",
      elapsed_sec: 3,
      error: null,
      summary: null,
    },
  ],
};

for (const { cell: layout, reducedMotion: reduce } of withAppearance([
  { name: "desktop-short", viewport: { width: 1280, height: 600 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
])) {
  const reducedMotion = reduce ? "reduce" : "no-preference";
  test(`Prepare: the running transcription stays in view (${layout.name}, ${reducedMotion})`, async ({
    page,
  }) => {
    await page.setViewportSize(layout.viewport);
    await page.emulateMedia({ reducedMotion });
    await page.route("**/api/pipeline/status", (route) =>
      route.fulfill({
        json: { running: true, job, jobs: [job], running_count: 1 },
      }),
    );
    await openProject(page, e2eProjectPath, { stage: "prepare" });
    const bar = page
      .getByRole("progressbar", { name: /transcription$/ })
      .first();
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
