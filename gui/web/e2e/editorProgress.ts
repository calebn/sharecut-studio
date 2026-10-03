import { expect, type Page } from "@playwright/test";
import type { PipelineJobSnapshot } from "../src/types/pipeline";
import type { createEditorProfiler } from "./editorProfile";
import { failureReason, hash, measured } from "./editorProfileReport";

type ReplayEvidence = {
  scheduled: number;
  delivered: number;
  rendered: number;
  values: { value: number; atMs: number }[];
  deliveredAtMs: number[];
  widthsPx: number[];
  heightsPx: number[];
};
declare global {
  interface Window {
    __editorProgressReplay?: {
      connected: boolean;
      run(): Promise<ReplayEvidence>;
      restore(): void;
    };
  }
}

export async function replayPipelineProgress(
  page: Page,
  recorder: Awaited<ReturnType<typeof createEditorProfiler>>,
  projectPath: string,
  diagnostic = false,
) {
  const updates = 30;
  const cadenceMs = 50;
  const job: PipelineJobSnapshot = {
    id: "editor-profile-synthetic",
    project_path: projectPath,
    from_step: null,
    only_step: null,
    kind: "pipeline",
    status: "running",
    current: 0,
    total: updates,
    message: "Synthetic editor profile progress",
    error: null,
    elapsed_sec: 0,
    steps: [],
  };
  const payloadHash = hash(
    JSON.stringify({ ...job, project_path: "<workspace>", updates, cadenceMs }),
  );
  await page.evaluate(
    ({ job, updates, cadenceMs }) => {
      const NativeEventSource = window.EventSource;
      const transport: { source: ReplaySource | null } = { source: null };
      class ReplaySource extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        readyState = 1;
        url: string;
        withCredentials = false;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;
        constructor(url: string | URL, init?: EventSourceInit) {
          super();
          this.url = String(url);
          if (!this.url.includes(job.id))
            return new NativeEventSource(url, init) as unknown as ReplaySource;
          transport.source = this;
          window.__editorProgressReplay!.connected = true;
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = ReplaySource as unknown as typeof EventSource;
      window.__editorProgressReplay = {
        connected: false,
        async run() {
          if (!transport.source || transport.source.readyState !== 1)
            throw new Error(
              "Synthetic progress stream is not attached to the real consumer",
            );
          const target = transport.source;
          if (!target.onmessage)
            throw new Error("Real progress consumer listener is absent");
          target.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "progress", job }),
            }),
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const values: { value: number; atMs: number }[] = [];
          const deliveredAtMs: number[] = [];
          const widthsPx: number[] = [];
          const heightsPx: number[] = [];
          const started = performance.now();
          const bar = document.querySelector(
            '.pipeline-bar[role="progressbar"]',
          );
          if (!bar) throw new Error("Real pipeline progress UI is absent");
          const observer = new MutationObserver(() => {
            const value = Number(bar.getAttribute("aria-valuenow"));
            if (values.at(-1)?.value !== value)
              values.push({ value, atMs: performance.now() - started });
          });
          observer.observe(bar, {
            attributes: true,
            attributeFilter: ["aria-valuenow"],
          });
          try {
            for (let current = 1; current <= updates; current++) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, cadenceMs),
              );
              target.onmessage?.(
                new MessageEvent("message", {
                  data: JSON.stringify({
                    type: "progress",
                    job: {
                      ...job,
                      current,
                      elapsed_sec: (current * cadenceMs) / 1000,
                    },
                  }),
                }),
              );
              deliveredAtMs.push(performance.now() - started);
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              widthsPx.push(
                bar.querySelector(".pipeline-bar-fill")!.getBoundingClientRect()
                  .width,
              );
              heightsPx.push(bar.getBoundingClientRect().height);
            }
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
            return {
              scheduled: updates,
              delivered: deliveredAtMs.length,
              rendered: values.length,
              values,
              deliveredAtMs,
              widthsPx,
              heightsPx,
            };
          } finally {
            observer.disconnect();
          }
        },
        restore() {
          transport.source?.close();
          window.EventSource = NativeEventSource;
          delete window.__editorProgressReplay;
        },
      };
    },
    { job, updates, cadenceMs },
  );
  await page.route("**/api/pipeline/status", (route) =>
    route.fulfill({
      json: { running: true, job, jobs: [job], running_count: 1 },
    }),
  );
  let replayEvidence: ReplayEvidence | undefined;
  let primaryFailure: unknown;
  try {
    const pipeline = page.getByRole("button", { name: /^Pipeline(?: ●)?$/ });
    if (await pipeline.isVisible()) await pipeline.click();
    else {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await pipeline.click();
    }
    await expect
      .poll(() => page.evaluate(() => window.__editorProgressReplay!.connected))
      .toBe(true);
    const bar = page.locator('.pipeline-bar[role="progressbar"]');
    const separator = page.getByRole("separator", {
      name: "Resize editor panels",
    });
    if (await separator.isVisible()) await separator.press("Home");
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toBeAttached();
    const geometry = await bar.evaluate((element) => ({
      rect: element.getBoundingClientRect().toJSON(),
      style: {
        height: getComputedStyle(element).height,
        flexShrink: getComputedStyle(element).flexShrink,
      },
      ancestors: [
        ...(function* () {
          let node = element.parentElement;
          while (node) {
            yield node;
            node = node.parentElement;
          }
        })(),
      ].map((node) => ({
        class: node.className,
        rect: node.getBoundingClientRect().toJSON(),
        overflow: getComputedStyle(node).overflow,
      })),
    }));
    await recorder.attachJson("progress-geometry.json", geometry);
    await page.screenshot({ path: recorder.artifactPath("progress.png") });
    expect(
      geometry.rect.height,
      "real progress bar must have visible height",
    ).toBeGreaterThanOrEqual(4);
    await expect(bar).toBeVisible();
    await expect(bar).toBeInViewport();
    recorder.report.protocol.resources!.progress = {
      source: "replay",
      payloadHash,
      cadenceMs: measured(
        cadenceMs,
        "scheduled delay between timed replay snapshots; actual delivery times retained separately",
      ),
    };
    const sample = await recorder.measure(
      {
        id: "synthetic-progress",
        phase: diagnostic ? "diagnostic" : "warm",
        input: `synthetic EventSource through usePipelineJob; ${updates} snapshots at ${cadenceMs}ms intervals`,
      },
      async () => {
        const evidence = await page.evaluate(() =>
          window.__editorProgressReplay!.run(),
        );
        replayEvidence = evidence;
        expect(evidence.delivered).toBe(updates);
        expect(evidence.rendered).toBeGreaterThanOrEqual(2);
        expect(evidence.rendered).toBeLessThanOrEqual(evidence.delivered);
        await expect(bar).toHaveAttribute("aria-valuenow", "100");
        expect(new Set(evidence.widthsPx).size).toBeGreaterThanOrEqual(2);
        expect(Math.min(...evidence.heightsPx)).toBeGreaterThanOrEqual(4);
        return {
          kind: "progress",
          source: "replay",
          jobId: job.id,
          values: evidence.values.map((entry) => entry.value),
          widthsPx: evidence.widthsPx,
          minimumHeightPx: Math.min(...evidence.heightsPx),
          updatesObserved: evidence.rendered,
          updatesSent: measured(
            evidence.delivered,
            "timed replay onmessage deliveries; initialization excluded",
          ),
          observationMethod:
            "MutationObserver distinct ARIA percent commits; widths read on rAF",
          payloadHash,
        };
      },
    );
    await expect
      .poll(async () =>
        Math.abs(
          (await page
            .locator(".pipeline-bar-fill")
            .evaluate((element) => element.getBoundingClientRect().width)) -
            (await bar.evaluate((element) => element.clientWidth)),
        ),
      )
      .toBeLessThanOrEqual(1);
    await recorder.attachJson(
      "progress-terminal-geometry.json",
      await bar.evaluate((element) => ({
        percent: Number(element.getAttribute("aria-valuenow")),
        containerWidthPx: element.clientWidth,
        fillWidthPx: element
          .querySelector(".pipeline-bar-fill")!
          .getBoundingClientRect().width,
        heightPx: element.getBoundingClientRect().height,
        method: "terminal settled geometry outside measured update window",
      })),
    );
    recorder.report.coverage = recorder.report.coverage.filter(
      (entry) => entry.id !== "synthetic-progress",
    );
    recorder.report.coverage.push({
      id: "synthetic-progress",
      result: sample.result,
    });
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure: unknown;
    for (const [label, cleanup] of [
      [
        "evidence",
        async () => {
          if (replayEvidence)
            await recorder.attachJson("progress-replay.json", replayEvidence);
        },
      ],
      ["route", () => page.unroute("**/api/pipeline/status")],
      [
        "EventSource",
        () => page.evaluate(() => window.__editorProgressReplay?.restore()),
      ],
    ] as const) {
      try {
        await cleanup();
      } catch (error) {
        recorder.report.errors.push(
          `replay ${label} cleanup: ${failureReason(error)}`,
        );
        cleanupFailure ??= error;
      }
    }
    if (primaryFailure === undefined && cleanupFailure !== undefined)
      throw cleanupFailure;
  }
}
