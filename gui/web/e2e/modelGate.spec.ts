import { expect, type Page, test } from "@playwright/test";
import { expectSurfaceAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  expectNoHorizontalScroll,
  expectTouchTargets,
  type Job,
  type Mock,
  mockBootstrap,
  mockModelFailingJob,
  prepare,
  ROWS,
  row,
  shot,
  THEMES,
  VIEWPORTS,
} from "./modelsMock";
import { openHostProject } from "./overlayReachability";
import { deliverPage, openPanel, phone, startExport } from "./stageNav";

/**
 * The model gate against a mocked `/api/bootstrap/*` and a mocked 409 `model_needed` on the Run
 * and Split speakers routes: nothing here downloads anything. Set MODELS_SHOTS_DIR to also save one
 * screenshot per viewport, theme and case.
 */

const GATE_RETRY_MS = 300;

function modelNeededBody(id: string) {
  const model = ROWS.find((r) => r.id === id)!;
  return {
    detail: {
      detail: `Needs ${model.label}; ask to download it.`,
      model: {
        id: model.id,
        model: model.model,
        label: model.label,
        purpose: model.purpose,
        size: model.size,
        size_bytes: model.size_bytes,
        command: "podcast bootstrap",
        state: "missing",
      },
    },
  };
}

const RUN_JOB = {
  id: "run-1",
  project_path: e2eProjectPath,
  from_step: null,
  only_step: null,
  status: "running",
  current: 0,
  total: 1,
  message: null,
  error: null,
  elapsed_sec: 0,
  steps: [],
};

type Routes = { posts: () => number };

/** A POST route that answers 409 `model_needed` for `id` until `ready()`, then a job. */
async function mockNeedingRoute(
  page: Page,
  pattern: string,
  id: string,
  ready: () => boolean,
): Promise<Routes> {
  let posts = 0;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posts += 1;
    if (ready()) {
      await route.fulfill({ json: { job: RUN_JOB } });
      return;
    }
    await route.fulfill({
      status: 409,
      headers: { "X-Sharecut-Error-Code": "model_needed" },
      json: modelNeededBody(id),
    });
  });
  return { posts: () => posts };
}

/** The host pipeline config with transcribe on and the chosen Whisper size marked cached. */
async function mockCachedConfig(page: Page): Promise<void> {
  const response = await page.request.get(
    `/api/pipeline/config?path=${encodeURIComponent(e2eProjectPath)}`,
  );
  expect(response.ok()).toBe(true);
  const config = await response.json();
  const transcribe = (config.config.transcribe ?? {}) as { model?: string };
  const defaults = (config.defaults.transcribe ?? {}) as { model?: string };
  const modelId = transcribe.model ?? defaults.model ?? "large-v3-turbo";
  const catalog = config.whisper_models ?? [];
  config.whisper_models = catalog.some((m: { id: string }) => m.id === modelId)
    ? catalog.map((m: { id: string }) => ({ ...m, cached: m.id === modelId }))
    : [
        ...catalog,
        {
          id: modelId,
          label: modelId,
          size: "?",
          description: "",
          cached: true,
        },
      ];
  config.enabled_steps = [
    ...new Set([...config.enabled_steps, "transcribe_tracks"]),
  ];
  await page.route("**/api/pipeline/config**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: config });
  });
}

/**
 * The download the stream reports, one stage at a time: 420 MB, then 1.2 GB, then done with the model
 * installed. Every reconnect repeats the current stage, and only `advance` or `finish` moves to the
 * next one, so what a case sees never depends on how long its checks take.
 */
function progressFrames(id: string, onDone: () => void) {
  let stage = 0;
  const frame = (job: Job) =>
    `retry: ${GATE_RETRY_MS}\n\ndata: ${JSON.stringify({ job })}\n\n`;
  const running = (bytes: number): Job => ({
    id: "job-1",
    kind: "bootstrap",
    components: [id],
    whisper_model: "large-v3-turbo",
    status: "running",
    download: { component: id, bytes, total: 1_600_000_000 },
  });
  const events: Mock["events"] = (mock) => {
    if (stage === 0) return frame(running(420_000_000));
    if (stage === 1) return frame(running(1_200_000_000));
    const target = mock.rows.find((r) => r.id === id);
    if (target) target.state = "installed";
    onDone();
    mock.job = null;
    return frame({
      id: "job-1",
      kind: "bootstrap",
      components: [id],
      whisper_model: "large-v3-turbo",
      status: "ok",
    });
  };
  return {
    events,
    advance: () => {
      stage += 1;
    },
    finish: () => {
      stage = 2;
    },
  };
}

async function openPipeline(page: Page): Promise<void> {
  await openPanel(page, "pipeline");
}

async function pressRun(page: Page) {
  await openPipeline(page);
  const run = page.getByRole("button", { name: "Run pipeline", exact: true });
  await expect(run).toBeEnabled();
  await run.click();
  return run;
}

async function mockSpeakerDoctor(page: Page): Promise<void> {
  await page.route("**/api/speaker/doctor", (route) =>
    route.fulfill({
      json: {
        available_backends: ["ecapa-onnx"],
        recommended: "ecapa-onnx",
      },
    }),
  );
}

async function openSplitSpeakers(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 720) {
    await phone.showTimeline(page);
  }
  await page
    .getByRole("button", { name: /^Open track details/ })
    .first()
    .dispatchEvent("click");
  await page
    .getByRole("button", { name: "Split speakers…", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Split speakers", exact: true }),
  ).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`model gate ${viewport.name} ${theme}`, () => {
      // Axe reads colors as painted: with motion on, a scan can land mid-fade and measure a blend.
      test.use({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
      });

      test("Run asks, shows the live bar, then resends the run", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        let downloaded = false;
        const progress = progressFrames("whisper", () => {
          downloaded = true;
        });
        const mock = await mockBootstrap(page, { events: progress.events });
        await mockCachedConfig(page);
        const run = await mockNeedingRoute(
          page,
          "**/api/pipeline/run",
          "whisper",
          () => downloaded,
        );
        await openHostProject(page);
        await pressRun(page);

        const gate = page.getByRole("dialog", { name: "Download Whisper?" });
        await expect(gate).toBeVisible();
        const download = gate.getByRole("button", {
          name: "Download",
          exact: true,
        });
        await expect(download).toBeInViewport();
        await expect(download).toBeFocused();
        expect(mock.runs).toEqual([]);
        expect(run.posts()).toBe(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(gate);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "gate-idle");

        await download.click();
        await expect.poll(() => mock.runs.length).toBe(1);
        expect(mock.runs[0]).toMatchObject({ components: ["whisper"] });
        const bar = gate.getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "gate-downloading");
        progress.advance();
        await expect(bar).toHaveAttribute("aria-valuetext", "1.2 GB of 1.6 GB");

        progress.finish();

        await expect(gate).toBeHidden();
        await expect.poll(run.posts).toBe(2);
      });

      test("a failed download keeps the prompt with Retry", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const failure = {
          kind: "disk",
          plain: "There isn't enough free disk space.",
        };
        await mockBootstrap(page, {
          events: () =>
            `retry: 3600000\n\ndata: ${JSON.stringify({
              job: {
                id: "job-1",
                kind: "bootstrap",
                components: ["whisper"],
                whisper_model: "large-v3-turbo",
                status: "error",
                error: failure.plain,
                failure,
                result: {
                  results: {
                    whisper: { ok: false, error: failure.plain, failure },
                  },
                },
              },
            })}\n\n`,
        });
        await mockCachedConfig(page);
        const run = await mockNeedingRoute(
          page,
          "**/api/pipeline/run",
          "whisper",
          () => false,
        );
        await openHostProject(page);
        await pressRun(page);
        const gate = page.getByRole("dialog", { name: "Download Whisper?" });
        await gate
          .getByRole("button", { name: "Download", exact: true })
          .click();

        await expect(gate.getByRole("alert")).toHaveText(failure.plain);
        const retry = gate.getByRole("button", { name: "Retry", exact: true });
        await expect(retry).toBeInViewport();
        await expect(
          gate.getByRole("button", { name: "Not now", exact: true }),
        ).toBeVisible();
        expect(run.posts()).toBe(1);
        await expectNoHorizontalScroll(page);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "gate-failed");
      });

      test("Not now leaves Run enabled with a hint and a way to Models", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page);
        await mockCachedConfig(page);
        const run = await mockNeedingRoute(
          page,
          "**/api/pipeline/run",
          "whisper",
          () => false,
        );
        await openHostProject(page);
        const button = await pressRun(page);
        const gate = page.getByRole("dialog", { name: "Download Whisper?" });
        await gate
          .getByRole("button", { name: "Not now", exact: true })
          .click();

        await expect(gate).toBeHidden();
        await expect(button).toBeEnabled();
        const hint = page.getByText(
          "Whisper is not downloaded. Run will ask again.",
        );
        await expect(hint).toBeVisible();
        expect(mock.runs).toEqual([]);
        await expectSurfaceAxeClean(page, ".pipeline-panel");
        await shot(page, viewport.name, theme, "gate-declined");

        await button.click();
        await expect(gate).toBeVisible();
        expect(run.posts()).toBe(2);

        await gate
          .getByRole("button", { name: "Manage models", exact: true })
          .click();
        const models = page.getByRole("dialog", { name: "Models" });
        await expect(models).toBeVisible();
        await expect(row(models, "Whisper")).toBeVisible();
        expect(mock.runs).toEqual([]);
      });

      test("a busy download slot shows the running job and no second start", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page, {
          runResponse: (_body, m) => {
            m.job = {
              id: "job-1",
              kind: "bootstrap",
              components: ["whisper"],
              whisper_model: "large-v3-turbo",
              status: "running",
              download: {
                component: "whisper",
                bytes: 420_000_000,
                total: 1_600_000_000,
              },
            };
            return {
              status: 409,
              headers: { "X-Sharecut-Error-Code": "bootstrap_job_running" },
              body: {
                detail: "Another download is already running (whisper)",
                running: ["whisper"],
                cancelling: false,
              },
            };
          },
        });
        await mockCachedConfig(page);
        await mockNeedingRoute(
          page,
          "**/api/pipeline/run",
          "whisper",
          () => false,
        );
        await openHostProject(page);
        await pressRun(page);
        const gate = page.getByRole("dialog", { name: "Download Whisper?" });
        await gate
          .getByRole("button", { name: "Download", exact: true })
          .click();

        await expect(gate.getByRole("progressbar")).toHaveAttribute(
          "aria-valuetext",
          "420 MB of 1.6 GB",
        );
        await expect(
          gate.getByRole("button", { name: "Cancel download", exact: true }),
        ).toBeInViewport();
        expect(mock.runs).toHaveLength(1);
        await expectNoHorizontalScroll(page);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "gate-busy");
      });
      test("Split speakers answers a stale 409 inside its own dialog", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        let downloaded = false;
        const rows = ROWS.map((r) => ({
          ...r,
          state: r.id === "speaker-ecapa" ? ("installed" as const) : r.state,
        }));
        const progress = progressFrames("speaker-ecapa", () => {
          downloaded = true;
        });
        const mock = await mockBootstrap(page, {
          rows,
          events: progress.events,
        });
        await mockSpeakerDoctor(page);
        const split = await mockNeedingRoute(
          page,
          "**/api/speaker/split",
          "speaker-ecapa",
          () => downloaded,
        );
        await openHostProject(page);
        await openSplitSpeakers(page);
        const dialog = page.getByRole("dialog", { name: "Split speakers" });
        await dialog
          .getByRole("button", { name: "Split speakers", exact: true })
          .click();

        const download = dialog.getByRole("button", {
          name: "Download",
          exact: true,
        });
        await expect(download).toBeInViewport();
        await expect(
          page.getByRole("dialog", { name: /^Download / }),
        ).toHaveCount(0);
        expect(split.posts()).toBe(1);
        await expectNoHorizontalScroll(page);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "split-idle");

        await download.click();
        const bar = dialog.getByRole("progressbar");
        await expect(bar).toHaveAttribute("aria-valuetext", "420 MB of 1.6 GB");
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "split-downloading");
        progress.finish();
        await expect.poll(split.posts).toBe(2);
        expect(mock.runs).toHaveLength(1);
      });

      test("Split speakers checks first and Not now returns to the settings", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page);
        await mockSpeakerDoctor(page);
        const split = await mockNeedingRoute(
          page,
          "**/api/speaker/split",
          "speaker-ecapa",
          () => false,
        );
        await openHostProject(page);
        await openSplitSpeakers(page);
        const dialog = page.getByRole("dialog", { name: "Split speakers" });
        await dialog
          .getByRole("button", { name: "Split speakers", exact: true })
          .click();
        await expect(dialog.getByText(/stored on this computer/)).toBeVisible();
        await expect(
          page.getByRole("dialog", { name: /^Download / }),
        ).toHaveCount(0);
        expect(split.posts()).toBe(0);

        await dialog
          .getByRole("button", { name: "Not now", exact: true })
          .click();
        await expect(
          dialog.getByRole("button", { name: "Split speakers", exact: true }),
        ).toBeEnabled();
        await expect(
          dialog.getByText(
            "Speaker model is not downloaded. Split speakers will ask again.",
          ),
        ).toBeVisible();
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        expect(mock.runs).toEqual([]);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await shot(page, viewport.name, theme, "split-declined");
      });

      test("Export asks inside Deliver, then exports once more", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        let downloaded = false;
        const progress = progressFrames("rnnoise", () => {
          downloaded = true;
        });
        const mock = await mockBootstrap(page, { events: progress.events });
        const exports = await mockModelFailingJob(page, {
          kind: "export",
          post: "**/api/export/deliverables",
          projectPath: e2eProjectPath,
          modelId: "rnnoise",
          ready: () => downloaded,
        });
        await openHostProject(page);
        await startExport(page);
        const dialog = deliverPage(page);

        await expect(dialog.getByText(/stored on this computer/)).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const download = dialog.getByRole("button", {
          name: "Download",
          exact: true,
        });
        await expect(download).toBeInViewport();
        await expect(download).toBeFocused();
        expect(mock.runs).toEqual([]);
        expect(exports.posts()).toBe(1);
        await expectNoHorizontalScroll(page);
        await expectTouchTargets(dialog);
        await expectSurfaceAxeClean(page, '[aria-label="Deliver"]');
        await shot(page, viewport.name, theme, "export-idle");

        await download.click();
        await expect.poll(() => mock.runs.length).toBe(1);
        expect(mock.runs[0]).toMatchObject({ components: ["rnnoise"] });
        const cancel = dialog.getByRole("button", { name: "Cancel download" });
        await expect(cancel).toBeInViewport();
        await expect(cancel).toBeFocused();
        await expect(dialog.getByRole("progressbar")).toHaveAttribute(
          "aria-valuetext",
          "420 MB of 1.6 GB",
        );
        await expectSurfaceAxeClean(page, '[aria-label="Deliver"]');
        await shot(page, viewport.name, theme, "export-downloading");
        progress.finish();

        await expect(dialog).toContainText(/Exported \d+ files? to export\//);
        expect(exports.posts()).toBe(2);
        await expectSurfaceAxeClean(page, '[aria-label="Deliver"]');
      });

      test("Export declined leaves a hint, and Download waits in the banner", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        const mock = await mockBootstrap(page);
        const exports = await mockModelFailingJob(page, {
          kind: "export",
          post: "**/api/export/deliverables",
          projectPath: e2eProjectPath,
          modelId: "rnnoise",
          ready: () => false,
        });
        await openHostProject(page);
        await startExport(page);
        const dialog = deliverPage(page);
        await dialog
          .getByRole("button", { name: "Not now", exact: true })
          .click();

        await expect(dialog).toContainText(
          "Noise reduction (RNNoise) is not downloaded.",
        );
        await expect(dialog.getByText(/Export will ask again/)).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectSurfaceAxeClean(page, '[aria-label="Deliver"]');
        await shot(page, viewport.name, theme, "export-declined");

        const chipDownload = page.getByRole("button", {
          name: "Download Noise reduction (RNNoise)",
        });
        await expect(chipDownload).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        if (
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches)
        ) {
          const box = await chipDownload.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
        }
        await expectSurfaceAxeClean(page, "body");
        await shot(page, viewport.name, theme, "export-chip");

        await chipDownload.click();
        await expect(
          page.getByRole("dialog", {
            name: "Download Noise reduction (RNNoise)?",
          }),
        ).toBeVisible();
        expect(mock.runs).toEqual([]);
        expect(exports.posts()).toBe(1);
      });

      test("a failed Refresh mix opens nothing until Download, then refreshes once", async ({
        page,
      }) => {
        await prepare(page, theme, true);
        let downloaded = false;
        const progress = progressFrames("rnnoise", () => {
          downloaded = true;
        });
        const mock = await mockBootstrap(page, { events: progress.events });
        const renders = await mockModelFailingJob(page, {
          kind: "render_preview",
          post: "**/api/pipeline/render-preview",
          projectPath: e2eProjectPath,
          modelId: "rnnoise",
          ready: () => downloaded,
        });
        await openHostProject(page);
        await page.locator("body").click({ position: { x: 1, y: 1 } });
        await page.keyboard.press("ControlOrMeta+b");

        const chipDownload = page.getByRole("button", {
          name: "Download Noise reduction (RNNoise)",
        });
        await expect(chipDownload).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(renders.posts()).toBe(1);
        expect(mock.runs).toEqual([]);

        await chipDownload.click();
        const gate = page.getByRole("dialog", {
          name: "Download Noise reduction (RNNoise)?",
        });
        await expect(gate).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectSurfaceAxeClean(page, '[role="dialog"]');
        await gate
          .getByRole("button", { name: "Download", exact: true })
          .click();
        await expect.poll(() => mock.runs.length).toBe(1);
        await expect(
          gate.getByRole("button", { name: "Cancel download" }),
        ).toBeFocused();
        progress.finish();
        await expect(gate).toBeHidden();
        await expect.poll(renders.posts).toBe(2);
      });
    });
  }
}

test.describe("model gate guest share", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a guest sees no prompt and makes no bootstrap calls", async ({
    browser,
    page,
  }) => {
    const { withShareableProject } = await import("./shareableProject");
    const { createReviewShare, openGuestShare, openHostShare } = await import(
      "./shareNavigation"
    );
    await withShareableProject(async (projectPath) => {
      await openHostShare(page, projectPath);
      const token = await createReviewShare(page, projectPath, "editor");
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      try {
        const guest = await context.newPage();
        const bootstrap: string[] = [];
        guest.on("request", (request) => {
          if (new URL(request.url()).pathname.startsWith("/api/bootstrap/")) {
            bootstrap.push(request.url());
          }
        });
        await openGuestShare(guest, token);
        await expect(
          guest.getByRole("dialog", { name: /^Download / }),
        ).toHaveCount(0);
        await expect(
          guest.getByRole("button", { name: /^Download / }),
        ).toHaveCount(0);
        expect(bootstrap).toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
});
