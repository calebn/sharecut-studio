import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";

import {
  counterDeltas,
  type EditorProfileReport,
  type FrameWindow,
  failureReason,
  fixtureIdentity,
  hash,
  type Measurement,
  measured,
  statistics,
  unavailable,
  type WaveformIdentity,
  type WorkloadDefinition,
  type WorkloadObservation,
  type WorkloadResult,
  type WorkloadSample,
} from "./editorProfileReport";

type WindowRecorder = { start(): void; stop(): FrameWindow };
declare global {
  interface Window {
    __editorProfileWindow?: WindowRecorder;
  }
}
function installWindowRecorder() {
  let active = false;
  let raf = 0;
  let previous: number | null = null;
  let started = 0;
  let data: FrameWindow;
  let observer: PerformanceObserver | null = null;
  const supported =
    PerformanceObserver.supportedEntryTypes.includes("longtask");
  const collect = (entries: PerformanceEntry[]) => {
    for (const entry of entries)
      if (entry.startTime >= started)
        data.longTaskDurationsMs.push(entry.duration);
  };
  const tick = (time: number) => {
    if (!active) return;
    if (previous !== null) {
      if (data.intervalsMs.length < 10000)
        data.intervalsMs.push(time - previous);
      else data.capped = true;
    }
    previous = time;
    raf = requestAnimationFrame(tick);
  };
  window.__editorProfileWindow = {
    start() {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      started = performance.now();
      previous = null;
      data = {
        intervalsMs: [],
        capped: false,
        longTaskDurationsMs: [],
        longTasksSupported: supported,
      };
      active = true;
      if (supported) {
        observer = new PerformanceObserver((list) =>
          collect(list.getEntries()),
        );
        observer.observe({ type: "longtask" });
      }
      performance.mark("editor-profile-start");
      raf = requestAnimationFrame(tick);
    },
    stop() {
      active = false;
      cancelAnimationFrame(raf);
      if (observer) {
        collect(observer.takeRecords());
        observer.disconnect();
      }
      performance.mark("editor-profile-end");
      return data;
    },
  };
  window.__editorProfileWindow.start();
}

export function readWaveforms(
  projectPath: string,
): Measurement<WaveformIdentity[]> {
  try {
    const root = path.join(path.dirname(projectPath), "artifacts", "peaks");
    const waveforms = fs
      .readdirSync(root)
      .filter((name) => name.endsWith(".wfpk"))
      .map((name) => {
        const match = /^(.+)\.[^.]+\.wfpk$/.exec(name);
        if (!match) throw new Error(`Unknown waveform filename ${name}`);
        return {
          ref: match[1]!,
          sha256: hash(fs.readFileSync(path.join(root, name))),
        };
      })
      .sort((a, b) => a.ref.localeCompare(b.ref));
    if (
      !waveforms.length ||
      new Set(waveforms.map((item) => item.ref)).size !== waveforms.length
    )
      throw new Error("Missing or ambiguous prebuilt waveform refs");
    return measured(
      waveforms,
      "SHA256 of actual prebuilt .wfpk bytes by stable ref; generated media-key filename excluded",
    );
  } catch (error) {
    return unavailable(failureReason(error));
  }
}

export async function createEditorProfiler(
  page: Page,
  cdp: CDPSession,
  info: TestInfo,
  projectPath: string,
  scrubRounds: number,
  headless: boolean,
) {
  const output = process.env.DAW_PROFILE_OUT
    ? path.resolve(process.env.DAW_PROFILE_OUT)
    : info.outputPath("editor-profile");
  fs.mkdirSync(output, { recursive: true });
  const assets: { path: string; sha256: string }[] = [];
  const assetReads: Promise<void>[] = [];
  let hookMarker = false;
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!/\.(js|css)$/.test(url.pathname)) return;
    assetReads.push(
      response
        .body()
        .then((bytes) => {
          assets.push({ path: url.pathname, sha256: hash(bytes) });
          hookMarker ||=
            bytes.includes("__SHARECUT_E2E") ||
            bytes.includes("__recordSignalCount");
        })
        .catch(() => undefined),
    );
  });
  const report: EditorProfileReport = {
    schemaVersion: 1,
    measurementVersion: "editor-response-v1",
    status: "incomplete",
    fixture: fixtureIdentity(
      fs.readFileSync(projectPath, "utf8"),
      projectPath,
      readWaveforms(projectPath),
    ),
    environment: {
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
      node: process.version,
      host: {
        hostname: os.hostname(),
        os: `${os.platform()} ${os.release()}`,
        architecture: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? null,
        logicalCpus: os.cpus().length,
        memoryBytes: os.totalmem(),
      },
      browser: page.context().browser()?.version() ?? "unknown",
      viewport: page.viewportSize(),
      headless,
      page: unavailable("not loaded"),
      build: unavailable("served assets not observed"),
      playwrightTrace: info.project.use.trace ?? "off",
      chromeTrace: "separate-diagnostic-window",
      cache: "fresh-context; prebuilt-waveforms; OS/server caches uncontrolled",
      gc: "forced after frame windows and each endurance round",
    },
    protocol: {
      scrubRounds,
      arrowPressesPerRound: 10,
      warmupActions: 0,
      retries: info.project.retries,
      repeatIndex: info.repeatEachIndex,
      frameLimit: 10000,
    },
    samples: [],
    memory: [],
    coverage: [
      [
        "clip-drag",
        "requires a legal drag fixture and durable restore outside this slice",
      ],
      ["boundary-drag", "specialized archived-word setup excluded"],
      [
        "playback",
        "silent fixture does not establish heard playback or audio graph behavior",
      ],
      ["cold-waveform", "generator prebuilds pyramids without decoding"],
      ["native-touch", "desktop browser driver is not physical touch"],
      [
        "synthetic-progress",
        "real consumer attached in attempted replay, but progress bar computed height stayed 0px before and after ordinary panel resize; width-transition cost not measured",
      ],
    ].map(([id, reason]) => ({
      id: id!,
      result: { status: "not-run", reason: reason! },
    })),
    artifacts: [],
    errors: [],
  };
  await cdp.send("Performance.enable");
  await page.addInitScript(installWindowRecorder);
  await page.evaluate(installWindowRecorder);
  const start = performance.now();
  const snapshot = async (): Promise<Measurement<Record<string, number>>> => {
    try {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return measured(
        Object.fromEntries(metrics.map(({ name, value }) => [name, value])),
        "CDP Performance.getMetrics raw counters",
      );
    } catch (error) {
      return unavailable(failureReason(error));
    }
  };
  const retain = () =>
    fs.writeFileSync(
      path.join(output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  retain();
  return {
    report,
    async measure(
      definition: WorkloadDefinition,
      action: () => Promise<WorkloadObservation>,
    ) {
      await page.evaluate(() => window.__editorProfileWindow!.start());
      const before = await snapshot();
      const actionStart = performance.now();
      let result: WorkloadResult;
      let failure: unknown;
      try {
        const observation = await action();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        result = { status: "completed", observation };
      } catch (error) {
        failure = error;
        result = { status: "failed", reason: failureReason(error) };
      }
      const driverWallMs = performance.now() - actionStart;
      let frames: Measurement<
        FrameWindow & { statistics: ReturnType<typeof statistics> }
      >;
      try {
        const raw = await page.evaluate(() =>
          window.__editorProfileWindow!.stop(),
        );
        frames = measured(
          { ...raw, statistics: statistics(raw.intervalsMs) },
          "page-local rAF scheduling intervals; navigation starts a new document window",
        );
      } catch (error) {
        frames = unavailable(failureReason(error));
      }
      const after = await snapshot();
      const longTasks =
        frames.status === "measured" && frames.value.longTasksSupported
          ? measured(
              {
                count: frames.value.longTaskDurationsMs.length,
                totalMs: frames.value.longTaskDurationsMs.reduce(
                  (n, t) => n + t,
                  0,
                ),
                maximumMs: Math.max(0, ...frames.value.longTaskDurationsMs),
              },
              "PerformanceObserver longtask; starts within window",
            )
          : unavailable("longtask observer unsupported or window unavailable");
      const sample: WorkloadSample = {
        ...definition,
        iteration: definition.iteration ?? 1,
        result,
        driverWallMs,
        frames,
        longTasks,
        cdp: counterDeltas(before, after),
        rawCounters: { before, after },
      };
      report.samples.push(sample);
      retain();
      if (failure !== undefined) throw failure;
      return sample;
    },
    async memory(label: string) {
      const domNodes = await page.evaluate(
        () => document.getElementsByTagName("*").length,
      );
      const gcStart = performance.now();
      await cdp.send("HeapProfiler.collectGarbage");
      const gcMs = performance.now() - gcStart;
      const { usedSize: heapBytes } = await cdp.send("Runtime.getHeapUsage");
      const checkpoint = {
        label,
        elapsedMs: performance.now() - start,
        gcMs,
        domNodes,
        heapBytes,
      };
      report.memory.push(checkpoint);
      retain();
      return checkpoint;
    },
    async trace(action: () => Promise<void>) {
      await cdp.send("Tracing.start", {
        categories: "devtools.timeline,blink.user_timing,v8",
        transferMode: "ReturnAsStream",
      });
      let failure: unknown;
      try {
        await action();
      } catch (error) {
        failure = error;
      } finally {
        try {
          let timer: ReturnType<typeof setTimeout>;
          const completed = new Promise<{ stream?: string }>(
            (resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Chrome trace completion timed out")),
                10_000,
              );
              cdp.once("Tracing.tracingComplete", resolve);
            },
          );
          let stream: string | undefined;
          try {
            await cdp.send("Tracing.end");
            ({ stream } = await completed);
          } finally {
            clearTimeout(timer!);
          }
          if (!stream) throw new Error("Chrome trace has no stream");
          let text = "";
          for (;;) {
            const part = await cdp.send("IO.read", { handle: stream });
            text += part.base64Encoded
              ? Buffer.from(part.data, "base64").toString("utf8")
              : part.data;
            if (part.eof) break;
          }
          await cdp.send("IO.close", { handle: stream });
          fs.writeFileSync(path.join(output, "chrome-trace.json"), text);
          report.artifacts.push("chrome-trace.json");
          const parsed = JSON.parse(text) as {
            traceEvents?: { name: string }[];
          };
          if (
            !parsed.traceEvents?.some((event) =>
              /RunTask|FunctionCall|Layout|editor-profile/.test(event.name),
            )
          )
            throw new Error("Chrome trace has no relevant workload events");
        } catch (error) {
          report.errors.push(`trace retention: ${failureReason(error)}`);
          failure ??= error;
        }
        retain();
      }
      if (failure !== undefined) throw failure;
    },
    async finish(failure?: unknown) {
      if (failure !== undefined) report.errors.push(failureReason(failure));
      try {
        await Promise.all(assetReads);
        const unique = [
          ...new Map(assets.map((asset) => [asset.path, asset])).values(),
        ].sort((a, b) => a.path.localeCompare(b.path));
        if (unique.length)
          report.environment.build = measured(
            {
              mode: unique.some((asset) => asset.path.includes("/@vite"))
                ? "development"
                : unique.every((asset) => asset.path.startsWith("/assets/"))
                  ? "production"
                  : "unknown",
              assets: unique,
              e2eHooks: hookMarker,
            },
            "SHA256 of actual served JS/CSS response bytes",
          );
        report.environment.page = measured(
          await page.evaluate(() => ({
            theme:
              document.documentElement.getAttribute("data-theme") ??
              getComputedStyle(document.documentElement).colorScheme,
            reducedMotion: matchMedia("(prefers-reduced-motion: reduce)")
              .matches,
            deviceScale: devicePixelRatio,
            hardwareConcurrency: navigator.hardwareConcurrency,
          })),
          "actual page settings",
        );
      } catch (error) {
        report.errors.push(`metadata: ${failureReason(error)}`);
      }
      report.status =
        report.errors.length ||
        report.samples.some((sample) => sample.result.status === "failed")
          ? "incomplete"
          : "complete";
      retain();
      await info.attach("editor-profile-report", {
        path: path.join(output, "report.json"),
        contentType: "application/json",
      });
      for (const artifact of report.artifacts)
        await info.attach(artifact, {
          path: path.join(output, artifact),
          contentType: "application/json",
        });
    },
  };
}
