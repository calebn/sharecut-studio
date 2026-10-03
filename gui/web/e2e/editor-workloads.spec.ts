import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Response, test } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { rulerWidthPx } from "./deepZoom";
import { postDocumentCommand, waiveRefineGate } from "./documentCommand";
import { createEditorProfiler } from "./editorProfile";
import {
  type ClipGeometry,
  failureReason,
  hash,
  unavailable,
} from "./editorProfileReport";
import { replayPipelineProgress } from "./editorProgress";
import { workloadResources } from "./editorWorkloadResources";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { parseTimecodeSec } from "./timecode";
import { zoomTimelineIn } from "./timelineZoom";
import { expectPaintedWaveformTile } from "./waveformHook";

type Recorder = Awaited<ReturnType<typeof createEditorProfiler>>;
const scene = process.env.DAW_PROFILE_SCENE;
const CLIENT = "editor-workload-profile";
function geometry(project: ProjectView, ids: string[]): ClipGeometry[] {
  return Object.values(project.clips.tracks)
    .flat()
    .filter((clip) => ids.includes(clip.id))
    .map((clip) => ({
      id: clip.id,
      trackId: clip.track_id,
      timelineStart: clip.timeline_start,
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end,
    }));
}
type CapturedCommand = {
  payload: {
    clips?: { clip_id: string; track_id: string; timeline_start: number }[];
    delta_sec?: number;
  };
};
async function fullProject(page: Page): Promise<ProjectView> {
  const response = await page.request.get(
    `/api/project?path=${encodeURIComponent(e2eProjectPath)}&phase=full`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function open(page: Page) {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /large-project benchmark/i,
    { timeout: 300000 },
  );
  await expect(page.locator(".clip-hit").first()).toBeVisible({
    timeout: 300000,
  });
}

async function zoomFirstClip(page: Page, minimumClipWidthPx = 120) {
  const clip = page.locator(".lane-row .clip-block").first();
  const raw = JSON.parse(fs.readFileSync(e2eProjectPath, "utf8"));
  const before = await clip.boundingBox();
  expect(before).toBeTruthy();
  const beforeScalePxPerSec =
    (await rulerWidthPx(page)) / raw.timeline.duration_sec;
  const initialCanvasCount = await page
    .locator("canvas.clip-waveform-tile")
    .count();
  const slider = page.getByRole("slider", { name: "Timeline position" });
  await slider.press("Home");
  await slider.focus();
  let zoomKeys = 0;
  while (
    (await clip.boundingBox())!.width < minimumClipWidthPx &&
    zoomKeys < 24
  ) {
    const result = await zoomTimelineIn(page, { maxSteps: 1 });
    zoomKeys += result.steps;
    await slider.press("Home");
  }
  const after = await clip.boundingBox();
  expect(after!.width).toBeGreaterThanOrEqual(minimumClipWidthPx);
  return {
    before,
    after,
    zoomKeys,
    minimumClipWidthPx,
    initialCanvasCount,
    beforeScalePxPerSec,
    afterScalePxPerSec: (await rulerWidthPx(page)) / raw.timeline.duration_sec,
  };
}

async function clipDrag(page: Page, recorder: Recorder) {
  await waiveRefineGate(page, "disposable profiling fixture");
  const preparation = await zoomFirstClip(page);
  recorder.report.protocol.preparation = {
    kind: "native-timeline-zoom",
    minimumClipWidthPx: preparation.minimumClipWidthPx,
    zoomKeys: preparation.zoomKeys,
    beforeScalePxPerSec: preparation.beforeScalePxPerSec,
    afterScalePxPerSec: preparation.afterScalePxPerSec,
  };
  await recorder.attachJson("clip-zoom-preparation.json", preparation);
  const block = page.locator(".lane-row .clip-block").first();
  const id = (await block.getAttribute("data-clip-id"))!;
  const before = await fullProject(page);
  const hit = block.locator(".clip-hit");
  await hit.click();
  const box = (await hit.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const owner = await hit.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      ownsCenter: target?.closest(".clip-hit") === element,
      tag: target?.tagName,
      class: target?.className,
    };
  });
  expect(owner.ownsCenter, "actual hit target is the clip body").toBe(true);
  await recorder.attachJson("clip-native-hit-target.json", owner);
  const commands: CapturedCommand[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/document/command") &&
      request.method() === "POST" &&
      request.postDataJSON()?.type === "MoveClips"
    )
      commands.push(request.postDataJSON());
  });
  await recorder.memory("before-drag");
  await recorder.measure(
    {
      id: "clip-drag-preview",
      phase: "warm",
      input:
        "native zoom prepared clip body >=120px; trusted pointer; 10 moves over 200ms; 40px",
    },
    async () => {
      const beforePx = (await block.boundingBox())!.x;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(x + i * 4, y);
        await page.waitForTimeout(20);
      }
      const ghost = page.locator(`.clip-moving[data-clip-id="${id}"]`);
      await expect(ghost).toBeVisible();
      const previewPx = (await ghost.boundingBox())!.x;
      expect(Math.abs(previewPx - beforePx)).toBeGreaterThan(4);
      expect(commands).toHaveLength(0);
      return {
        kind: "drag-preview",
        target: "clip",
        id,
        beforePx,
        previewPx,
        commandCount: 0,
      };
    },
  );
  const save = await recorder.measure(
    {
      id: "clip-drag-save",
      phase: "warm",
      input:
        "pointer release; durable MoveClips; exact Undo restore outside input window",
    },
    async () => {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/document/command") &&
          r.request().postDataJSON()?.type === "MoveClips",
      );
      await page.mouse.up();
      expect((await response).ok()).toBe(true);
      expect(commands).toHaveLength(1);
      const after = await fullProject(page);
      expect(after.clips).not.toEqual(before.clips);
      const expected = commands[0]!.payload.clips!;
      expect(expected.length).toBeGreaterThan(0);
      for (const placement of expected) {
        const saved = geometry(after, [placement.clip_id])[0]!;
        expect(saved.trackId).toBe(placement.track_id);
        expect(saved.timelineStart).toBeCloseTo(placement.timeline_start, 6);
      }
      return {
        kind: "drag-save",
        target: "clip",
        commandType: "MoveClips",
        commandCount: 1,
        before: geometry(before, [id]),
        after: geometry(after, [id]),
        restoration: "pending",
      };
    },
  );
  await postDocumentCommand(page, CLIENT, "UndoHistory", { rerender: false });
  const restored = (await fullProject(page)).clips;
  expect(restored).toEqual(before.clips);
  if (
    save.result.status === "completed" &&
    save.result.observation.kind === "drag-save"
  )
    save.result.observation.restoration = "verified";
  await recorder.attachJson("clip-exact-undo.json", {
    before: before.clips,
    restored,
  });
  await recorder.memory("after-drag-restore");
}

async function boundaryDrag(page: Page, recorder: Recorder) {
  await waiveRefineGate(page, "disposable profiling boundary");
  const raw = JSON.parse(fs.readFileSync(e2eProjectPath, "utf8"));
  const first = raw.timeline.clips[0];
  const duration = first.source_end - first.source_start;
  const start = first.timeline_start + duration * 0.25,
    end = first.timeline_start + duration * 0.6;
  await postDocumentCommand(page, CLIENT, "RippleDeleteRange", { start, end });
  const before = await fullProject(page);
  const boundary =
    before.edit_boundaries?.find(
      (entry) => entry.cutaway_word_ids.length > 0,
    ) ?? before.edit_boundaries?.[0];
  expect(boundary, "actual cut produced a boundary").toBeTruthy();
  const panels = page.getByLabel("Editor panels");
  await panels.getByRole("button", { name: "Transcript", exact: true }).click();
  const annotate = panels.locator(".transcript-annotate-btn");
  if ((await annotate.getAttribute("aria-pressed")) !== "true")
    await annotate.click();
  const mark = page.locator(
    `.edit-boundary-mark[data-boundary-id="${boundary!.id}"]`,
  );
  await expect(mark).toBeVisible();
  await mark.scrollIntoViewIfNeeded();
  const box = (await mark.boundingBox())!,
    x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const commands: CapturedCommand[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/document/command") &&
      request.method() === "POST" &&
      request.postDataJSON()?.type === "RollClipJoin"
    )
      commands.push(request.postDataJSON());
  });
  await recorder.memory("before-boundary");
  await recorder.measure(
    {
      id: "boundary-drag-preview",
      phase: "warm",
      input: "trusted pointer; 10 moves over 200ms; 24px",
    },
    async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      const delta = page.locator(".edit-boundary-delta");
      const deltasSec: number[] = [];
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(x + i * 2.4, y);
        await page.waitForTimeout(20);
        if (await delta.count()) {
          const value = /Roll join ([+-][\d.]+)s/.exec(await delta.innerText());
          if (value) deltasSec.push(Number(value[1]));
        }
      }
      await expect(delta).toBeVisible();
      const previewLabel = await delta.innerText();
      expect(previewLabel).toMatch(/Roll join \+0\.[1-9]/);
      expect(new Set(deltasSec).size).toBeGreaterThanOrEqual(2);
      expect(commands).toHaveLength(0);
      return {
        kind: "boundary-preview",
        id: boundary!.id,
        deltasSec,
        previewLabel,
        commandCount: 0,
      };
    },
  );
  await page.screenshot({
    path: recorder.artifactPath("boundary-held-preview.png"),
  });
  const save = await recorder.measure(
    {
      id: "boundary-drag-save",
      phase: "warm",
      input: "pointer release; durable RollClipJoin; exact Undo restore",
    },
    async () => {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/document/command") &&
          r.request().postDataJSON()?.type === "RollClipJoin",
      );
      await page.mouse.up();
      expect((await response).ok()).toBe(true);
      expect(commands).toHaveLength(1);
      const after = await fullProject(page);
      expect(after.clips).not.toEqual(before.clips);
      const delta = commands[0]!.payload.delta_sec!;
      expect(delta).toBeGreaterThan(0);
      const leftBefore = geometry(before, [boundary!.left_clip_id])[0]!;
      const leftAfter = geometry(after, [boundary!.left_clip_id])[0]!;
      expect(leftAfter.sourceEnd).toBeCloseTo(leftBefore.sourceEnd + delta, 6);
      const rightBefore = geometry(before, [boundary!.right_clip_id!])[0]!;
      const rightAfter = geometry(after, [boundary!.right_clip_id!])[0]!;
      expect(rightAfter.sourceStart).toBeCloseTo(
        rightBefore.sourceStart + delta,
        6,
      );
      return {
        kind: "drag-save",
        target: "boundary",
        commandType: "RollClipJoin",
        commandCount: 1,
        before: geometry(before, [
          boundary!.left_clip_id,
          boundary!.right_clip_id!,
        ]),
        after: geometry(after, [
          boundary!.left_clip_id,
          boundary!.right_clip_id!,
        ]),
        restoration: "pending",
      };
    },
  );
  await postDocumentCommand(page, CLIENT, "UndoHistory", { rerender: false });
  const restored = (await fullProject(page)).clips;
  expect(restored).toEqual(before.clips);
  if (
    save.result.status === "completed" &&
    save.result.observation.kind === "drag-save"
  )
    save.result.observation.restoration = "verified";
  await recorder.attachJson("boundary-exact-undo.json", {
    before: before.clips,
    restored,
  });
  await recorder.memory("after-boundary-restore");
}

async function playback(page: Page, recorder: Recorder) {
  let mediaResponses = 0;
  page.on("response", (response) => {
    if (response.ok() && /\/api\/(audio|media)/.test(response.url()))
      mediaResponses++;
  });
  const clock = page.locator("header.transport .timecode-current");
  await page.getByRole("button", { name: "Original", exact: true }).click();
  await page.getByRole("slider", { name: "Timeline position" }).press("Home");
  await recorder.memory("before-playback");
  await recorder.measure(
    {
      id: "playback",
      phase: "sustained",
      input: "real Play; 5sec active graph; Pause and 600ms held clock",
    },
    async () => {
      const beforeSeconds = parseTimecodeSec(await clock.innerText());
      await page.getByRole("button", { name: "Play", exact: true }).click();
      const meter = page.getByRole("meter", {
        name: "reference playback level",
      });
      await expect
        .poll(async () => Number(await meter.getAttribute("aria-valuenow")))
        .toBeGreaterThan(-50);
      const peakDb = Number(await meter.getAttribute("aria-valuenow"));
      await page.waitForTimeout(5000);
      const afterSeconds = parseTimecodeSec(await clock.innerText());
      expect(afterSeconds).toBeGreaterThan(beforeSeconds + 3);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      const paused = await clock.innerText();
      await page.waitForTimeout(600);
      expect(await clock.innerText()).toBe(paused);
      await expect(page.locator(".pill.audio-error")).toHaveCount(0);
      expect(mediaResponses).toBeGreaterThan(0);
      return {
        kind: "playback",
        beforeSeconds,
        afterSeconds,
        peakDb,
        mediaResponses,
        pausedAfter: true,
      };
    },
  );
  await recorder.memory("after-playback");
}

async function realProgress(page: Page, recorder: Recorder) {
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page
    .getByRole("separator", { name: "Resize editor panels" })
    .press("Home");
  await page.getByText("From / Only shortcuts", { exact: true }).click();
  await page.getByRole("combobox", { name: /^Only step/ }).selectOption("");
  await page
    .getByRole("combobox", { name: /^From step/ })
    .selectOption("compress_tracks");
  const toggles = page.getByRole("checkbox", { name: /^Enable / });
  await expect(
    page.getByRole("checkbox", { name: "Enable Balance tracks", exact: true }),
  ).toBeVisible();
  await expect.poll(() => toggles.count()).toBeGreaterThan(2);
  for (const toggle of await toggles.all()) {
    const label = await toggle.getAttribute("aria-label");
    const enabled = [
      "Enable Ingest tracks",
      "Enable Clean audio",
      "Enable Compress tracks",
      "Enable Balance tracks",
    ].includes(label ?? "");
    if ((await toggle.isChecked()) !== enabled) {
      const saved = page.waitForResponse(
        (response) =>
          response.url().includes("/api/pipeline/config") &&
          response.request().method() === "PUT",
      );
      await toggle.setChecked(enabled);
      expect((await saved).ok()).toBe(true);
      if (enabled) await expect(toggle).toBeChecked();
      else await expect(toggle).not.toBeChecked();
    }
  }
  const confirmedResponse = await page.request.get(
    `/api/pipeline/config?path=${encodeURIComponent(e2eProjectPath)}`,
  );
  expect(confirmedResponse.ok()).toBe(true);
  const confirmed = await confirmedResponse.json();
  expect([...confirmed.enabled_steps].sort()).toEqual([
    "balance_tracks",
    "clean_audio",
    "compress_tracks",
    "ingest_tracks",
  ]);
  expect(
    await toggles.evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLInputElement).checked)
        .map((element) => element.getAttribute("aria-label"))
        .sort(),
    ),
  ).toEqual([
    "Enable Balance tracks",
    "Enable Clean audio",
    "Enable Compress tracks",
    "Enable Ingest tracks",
  ]);
  const run = page.getByRole("button", { name: "Run pipeline", exact: true });
  await expect(run).toBeEnabled();
  const streamResponses: {
    url: string;
    status: number;
    contentType: string;
  }[] = [];
  const observeStream = (response: Response) => {
    if (response.url().includes("/api/pipeline/events"))
      streamResponses.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] ?? "",
      });
  };
  page.on("response", observeStream);
  let progressEvidence:
    | {
        jobId: string;
        values: number[];
        widthsPx: number[];
        heights: number[];
        terminal: boolean;
        requestBody: unknown;
        startedJob: unknown;
        statusSnapshots: unknown[];
        streamResponses: typeof streamResponses;
        observedFrames?: {
          value: number;
          width: number;
          height: number;
          atMs: number;
        }[];
        finalJob?: unknown;
      }
    | undefined;
  await page.evaluate(() => {
    const samples: {
      value: number;
      width: number;
      height: number;
      atMs: number;
    }[] = [];
    let frame = 0;
    const observe = () => {
      const bar = document.querySelector('.pipeline-bar[role="progressbar"]');
      if (bar) {
        const value = Number(bar.getAttribute("aria-valuenow"));
        const rect = bar.getBoundingClientRect();
        const fill = bar
          .querySelector(".pipeline-bar-fill")
          ?.getBoundingClientRect();
        if (
          rect.height >= 4 &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          fill
        ) {
          const observation = {
            value,
            width: fill.width,
            height: rect.height,
            atMs: performance.now(),
          };
          if (samples.at(-1)?.value !== value) samples.push(observation);
          else Object.assign(samples.at(-1)!, observation);
        }
      }
      frame = requestAnimationFrame(observe);
    };
    const owner = window as typeof window & {
      profileProgressObservation?: {
        samples: typeof samples;
        stop: () => void;
      };
    };
    owner.profileProgressObservation = {
      samples,
      stop: () => cancelAnimationFrame(frame),
    };
    frame = requestAnimationFrame(observe);
  });
  let progressFailure: unknown;
  try {
    await recorder.measure(
      {
        id: "real-progress",
        phase: "warm",
        input:
          "real compress_tracks + balance_tracks pipeline; native SSE consumer; full-clock local PCM sources",
      },
      async () => {
        const startedResponse = page.waitForResponse(
          (response) =>
            response.url().includes("/api/pipeline/run") &&
            response.request().method() === "POST",
          { timeout: 15000 },
        );
        await run.click();
        const response = await startedResponse;
        expect(response.ok(), await response.text()).toBe(true);
        const body = response.request().postDataJSON();
        expect(body.only_step).toBeNull();
        expect(body.from_step).toBe("compress_tracks");
        expect([...body.enabled_steps].sort()).toEqual([
          "balance_tracks",
          "clean_audio",
          "compress_tracks",
          "ingest_tracks",
        ]);
        const payloadHash = hash(
          JSON.stringify({ ...body, path: "<workspace>" }),
        );
        recorder.report.protocol.resources!.progress = {
          source: "real-job",
          payloadHash,
          cadenceMs: unavailable("natural producer cadence not instrumented"),
        };
        const { job } = await response.json();
        const values: number[] = [],
          widthsPx: number[] = [],
          heights: number[] = [];
        progressEvidence = {
          jobId: job.id,
          values,
          widthsPx,
          heights,
          terminal: false,
          requestBody: body,
          startedJob: job,
          statusSnapshots: [],
          streamResponses,
        };
        const bar = page.locator('.pipeline-bar[role="progressbar"]');
        let terminal = false;
        const started = Date.now();
        while (Date.now() - started < 20 * 60000) {
          const status = await page.request.get("/api/pipeline/status");
          const result = await status.json();
          const current = (result.jobs ?? [result.job]).find(
            (entry: { id: string }) => entry?.id === job.id,
          );
          if (current) progressEvidence.statusSnapshots.push(current);
          if (await bar.count()) await bar.scrollIntoViewIfNeeded();
          if (
            current &&
            ["ok", "error", "cancelled"].includes(current.status)
          ) {
            expect(current.status, JSON.stringify(current)).toBe("ok");
            terminal = true;
            progressEvidence.terminal = true;
            progressEvidence.finalJob = current;
            expect(
              current.steps.map((step: { name: string }) => step.name),
            ).toEqual(["compress_tracks", "balance_tracks"]);
            expect(
              current.steps.every(
                (step: { status: string }) => step.status === "ok",
              ),
            ).toBe(true);
            expect(current.steps[1].summary).toContain("2 tracks gain-staged");
            break;
          }
          await page.waitForTimeout(100);
        }
        progressEvidence.terminal = terminal;
        await page.waitForTimeout(100);
        const samples = await page.evaluate(() => {
          const owner = window as typeof window & {
            profileProgressObservation?: {
              samples: {
                value: number;
                width: number;
                height: number;
                atMs: number;
              }[];
              stop: () => void;
            };
          };
          owner.profileProgressObservation?.stop();
          return owner.profileProgressObservation?.samples ?? [];
        });
        progressEvidence.observedFrames = samples;
        expect(
          streamResponses.some(
            (stream) =>
              stream.url.includes(`job_id=${job.id}`) &&
              stream.status === 200 &&
              stream.contentType.includes("text/event-stream"),
          ),
          "actual native job SSE transport connected",
        ).toBe(true);
        for (const sample of samples) {
          values.push(sample.value);
          widthsPx.push(sample.width);
          heights.push(sample.height);
        }
        expect(terminal, "real job completed").toBe(true);
        expect(
          values.length,
          "at least two genuinely visible real-job progress changes",
        ).toBeGreaterThanOrEqual(3);
        expect(new Set(widthsPx).size).toBeGreaterThanOrEqual(2);
        expect(
          samples.some(
            (sample) =>
              sample.value > 0 && sample.value < 100 && sample.width > 0,
          ),
          "actual intermediate fill geometry",
        ).toBe(true);
        expect(Math.min(...heights)).toBeGreaterThanOrEqual(4);
        return {
          kind: "progress",
          source: "real-job",
          jobId: job.id,
          values,
          widthsPx,
          minimumHeightPx: Math.min(...heights),
          updatesObserved: values.length,
          updatesSent: unavailable(
            "native SSE producer count not instrumented",
          ),
          observationMethod:
            "last requestAnimationFrame viewport geometry per distinct ARIA interval; no compositor paint or producer count claim",
          payloadHash,
        };
      },
    );
    const bar = page.locator('.pipeline-bar[role="progressbar"]');
    await expect(bar).toHaveAttribute("aria-valuenow", "100");
    await expect
      .poll(() =>
        bar.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().width -
              element
                .querySelector(".pipeline-bar-fill")!
                .getBoundingClientRect().width,
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
    await recorder.attachJson(
      "real-job-terminal-geometry.json",
      await bar.evaluate((element) => ({
        percent: Number(element.getAttribute("aria-valuenow")),
        rect: element.getBoundingClientRect().toJSON(),
        fill: element
          .querySelector(".pipeline-bar-fill")!
          .getBoundingClientRect()
          .toJSON(),
      })),
    );
  } catch (error) {
    progressFailure = error;
    throw error;
  } finally {
    try {
      page.off("response", observeStream);
      await page.evaluate(() => {
        const owner = window as typeof window & {
          profileProgressObservation?: { stop: () => void };
        };
        owner.profileProgressObservation?.stop();
      });
      if (progressEvidence)
        await recorder.attachJson("real-job-progress.json", progressEvidence);
    } catch (error) {
      recorder.report.errors.push(
        `real progress retention: ${failureReason(error)}`,
      );
      if (progressFailure === undefined) throw error;
    }
  }
}

test.describe("remaining editor workloads (opt-in)", () => {
  test.skip(
    !scene,
    "requires profile:remaining runner and isolated disposable fixture",
  );
  test("performs an observable isolated workload", async ({
    page,
    headless,
  }, info) => {
    test.setTimeout(30 * 60000);
    page.setDefaultTimeout(15000);
    assertDisposableE2eProject(e2eProjectPath);
    if (scene === "progress-reduced")
      await page.emulateMedia({ reducedMotion: "reduce" });
    const required =
      scene === "clip"
        ? ["clip-drag-preview", "clip-drag-save"]
        : scene === "boundary"
          ? ["boundary-drag-preview", "boundary-drag-save"]
          : scene === "progress-real"
            ? ["real-progress"]
            : scene?.startsWith("progress-")
              ? ["synthetic-progress"]
              : [scene!];
    const resources = await workloadResources(
      e2eProjectPath,
      scene === "cold-waveform",
    );
    const recorder = await createEditorProfiler(
      page,
      await page.context().newCDPSession(page),
      info,
      e2eProjectPath,
      0,
      headless,
      { scenario: scene!, requiredCoverage: required, resources },
    );
    recorder.report.protocol.repeatIndex = Number(
      process.env.DAW_PROFILE_REPEAT ?? 1,
    );
    let failure: unknown;
    const coldEvidence: {
      zoom?: Awaited<ReturnType<typeof zoomFirstClip>>;
      statusSnapshots: unknown[];
      generatedRefs?: string[];
    } = { statusSnapshots: [] };
    try {
      if (scene === "cold-waveform") {
        let tileResponses = 0;
        page.on("response", (response) => {
          if (response.ok() && response.url().includes("/api/waveform/tiles/"))
            tileResponses++;
        });
        const measureCold = async () =>
          recorder.measure(
            {
              id: "cold-waveform",
              phase: process.env.DAW_PROFILE_TRACE
                ? "diagnostic"
                : "first-load",
              input:
                "full-clock PCM decode from empty pyramid cache; detailed canvas paint after native timeline zoom to first clip >=80px; fresh server/context",
            },
            async () => {
              await open(page);
              coldEvidence.zoom = await zoomFirstClip(page, 80);
              recorder.report.protocol.preparation = {
                kind: "native-timeline-zoom",
                minimumClipWidthPx: coldEvidence.zoom.minimumClipWidthPx,
                zoomKeys: coldEvidence.zoom.zoomKeys,
                beforeScalePxPerSec: coldEvidence.zoom.beforeScalePxPerSec,
                afterScalePxPerSec: coldEvidence.zoom.afterScalePxPerSec,
              };
              await expect
                .poll(
                  async () => {
                    const response = await page.request.get(
                      `/api/waveform/status?path=${encodeURIComponent(e2eProjectPath)}&kind=raw`,
                    );
                    const status = await response.json();
                    coldEvidence.statusSnapshots.push(status);
                    expect(Object.keys(status.media)).toHaveLength(
                      resources.media.length,
                    );
                    return Object.values(status.media).every(
                      (entry: unknown) =>
                        (entry as { status?: string }).status === "ready",
                    );
                  },
                  { timeout: 20 * 60000 },
                )
                .toBe(true);
              const generatedRefs = fs
                .readdirSync(
                  path.join(path.dirname(e2eProjectPath), "artifacts", "peaks"),
                )
                .filter((name) => name.endsWith(".wfpk"));
              coldEvidence.generatedRefs = generatedRefs;
              expect(generatedRefs.length).toBeGreaterThanOrEqual(
                resources.media.length,
              );
              await expectPaintedWaveformTile(page);
              expect(tileResponses).toBeGreaterThan(0);
              return {
                kind: "waveform",
                initialPyramidCount: 0,
                generatedRefs,
                tileResponses,
                painted: true,
                sourceDurationSec: resources.media[0]!.durationSec,
              };
            },
          );
        if (process.env.DAW_PROFILE_TRACE)
          await recorder.trace(async () => {
            await measureCold();
          });
        else await measureCold();
        await page.screenshot({
          path: recorder.artifactPath("cold-waveform-painted.png"),
        });
      } else {
        await open(page);
        if (scene === "clip") await clipDrag(page, recorder);
        else if (scene === "boundary") await boundaryDrag(page, recorder);
        else if (scene === "playback") await playback(page, recorder);
        else if (scene === "progress-real") await realProgress(page, recorder);
        else if (scene?.startsWith("progress-")) {
          if (process.env.DAW_PROFILE_TRACE)
            await recorder.trace(async () => {
              await replayPipelineProgress(
                page,
                recorder,
                e2eProjectPath,
                true,
              );
            });
          else await replayPipelineProgress(page, recorder, e2eProjectPath);
        } else throw new Error(`Unknown workload ${scene}`);
      }
      await recorder.memory("after-workload");
    } catch (error) {
      failure = error;
      await page
        .screenshot({ path: recorder.artifactPath("failure.png") })
        .catch(() => undefined);
      throw error;
    } finally {
      if (scene === "cold-waveform")
        await recorder
          .attachJson("cold-waveform-consumer.json", coldEvidence)
          .catch((error) => {
            recorder.report.errors.push(
              `cold evidence retention: ${failureReason(error)}`,
            );
          });
      await page.mouse.up().catch(() => undefined);
      await recorder.finish(failure);
    }
  });
});
