import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../src/types/pipeline";
import { e2eProjectPath, repoRoot } from "./env";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { setTheme } from "./theme";

/** A tenth of a second of silence: enough for the server to take as a track. */
function silentWav(): Buffer {
  const rate = 8000;
  const samples = rate / 10;
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}

test("Prepare: the hand-off opens the next stage once the sources are ready", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath, { stage: "prepare" });
  const handoff = page.getByRole("button", { name: /^(Edit|Review)/ });
  await expect(handoff).toBeEnabled();
  await handoff.click();
  await expect(
    page.getByRole("tab", { name: /^(Edit|Review)\b/, selected: true }),
  ).toBeVisible();
});

test("Prepare: audio added next to transcribed tracks waits for Process new audio, then shows a waiting Run when the slot is busy", async ({
  page,
}) => {
  // The import adds a take: do it in a disposable copy so the shared project is left as found.
  await withShareableProject(async (projectPath) => {
    let posts = 0;
    let body: Record<string, unknown> | null = null;
    // The run is mocked: this spec is about when Prepare starts it, not about transcribing.
    await page.route("**/api/pipeline/run", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      posts += 1;
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        headers: { "X-Sharecut-Error-Code": "pipeline_busy" },
        json: { detail: "A pipeline job is already running" },
      });
    });
    await openProject(page, projectPath, { stage: "prepare" });
    await expect(
      page.getByRole("heading", { name: "Sources", exact: true }),
    ).toBeVisible();
    expect(posts).toBe(0);

    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: /^Import audio/ })
      .first()
      .click();
    await (await chooser).setFiles({
      name: "intro.wav",
      mimeType: "audio/wav",
      buffer: silentWav(),
    });

    const processNew = page.getByRole("button", { name: /^Process new audio/ });
    await expect(processNew).toBeVisible();
    expect(posts).toBe(0);
    await processNew.click();

    await expect.poll(() => posts).toBeGreaterThanOrEqual(1);
    expect(body).toMatchObject({ use_working_set: true });
    expect(body).not.toHaveProperty("force_transcribe", true);

    // The mock refuses the run (slot busy): Prepare says it is waiting and offers Run, not silence.
    await expect(
      page
        .getByText(/Another job is running\. This starts when it finishes/)
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Run/ }).first(),
    ).toBeVisible();
    await expect(page.getByText("Still getting ready")).toHaveCount(0);
  });
});

test("Prepare: Advanced opens the step sheet and Escape returns to the stage", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath, { stage: "prepare" });
  const advanced = page.getByRole("button", { name: /^Advanced/ });
  await advanced.click();
  // The sheet's title and the step list's own heading share the name.
  const sheet = page.getByRole("dialog", { name: "Advanced steps" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(advanced).toBeFocused();
});

type ProcessingProofProject = {
  timeline: { tracks: { id: string }[] };
  mix: {
    processing_chains: {
      track_id: string;
      effects: { effect: string; params: Record<string, unknown> }[];
    }[];
  };
};

function processingProofProject(projectPath: string): ProcessingProofProject {
  return JSON.parse(
    fs.readFileSync(projectPath, "utf8"),
  ) as ProcessingProofProject;
}

async function dismissFeedbackToast(page: Page): Promise<void> {
  const toast = page
    .getByRole("region", { name: "Status messages" })
    .locator(".ui-toast");
  const dismiss = toast.getByRole("button", { name: "Dismiss", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await expect(toast).toHaveCount(0);
}

async function scrollSheetTop(sheet: Locator): Promise<void> {
  await sheet.evaluate((element) => {
    element.scrollTop = 0;
    for (const scroller of element.querySelectorAll<HTMLElement>(
      ".sys-sheet-scroll, .bottom-sheet-body, .command-palette-body",
    ))
      scroller.scrollTop = 0;
  });
}

async function captureViewport(
  page: Page,
  info: TestInfo,
  directory: string,
  name: string,
  targets: Record<string, Locator>,
) {
  const geometry: Record<
    string,
    { x: number; y: number; width: number; height: number }
  > = {};
  for (const [label, target] of Object.entries(targets)) {
    await expect(target, `${name}: ${label}`).toBeInViewport({ ratio: 1 });
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(2);
    expect(box!.height).toBeGreaterThan(2);
    geometry[label] = box!;
  }
  await expect(page.locator(".ui-toast")).toHaveCount(0);
  const image = path.join(directory, `${name}.png`);
  await page.screenshot({
    path: image,
    fullPage: false,
    animations: "disabled",
  });
  await info.attach(name, { path: image, contentType: "image/png" });
  return { image: path.basename(image), targets: geometry };
}

for (const profile of [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
]) {
  for (const theme of ["light", "dark"] as const) {
    test(`Prepare: real selected ingest and high-pass processing, ${profile.name} ${theme}`, async ({
      page,
      browserName,
    }, testInfo) => {
      await page.setViewportSize(profile.viewport);
      await withShareableProject(async (projectPath) => {
        const selected = ["ingest_tracks", "clean_audio"];
        const savedResponse = await page.request.put("/api/pipeline/config", {
          data: {
            path: projectPath,
            enabled_steps: selected,
            unattended: true,
          },
        });
        expect(savedResponse.ok()).toBe(true);
        const saved = (await savedResponse.json()) as PipelineConfigResponse;
        expect(saved.enabled_steps).toEqual(selected);
        const originalIds = new Set(
          processingProofProject(projectPath).timeline.tracks.map(
            (track) => track.id,
          ),
        );
        const requests: Record<string, unknown>[] = [];
        page.on("request", (request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/pipeline/run"
          ) {
            requests.push(request.postDataJSON() as Record<string, unknown>);
          }
        });
        await openProject(page, projectPath, { stage: "prepare" });
        await setTheme(page, theme);
        const chooser = page.waitForEvent("filechooser");
        await page
          .getByRole("button", { name: /^Import audio/ })
          .first()
          .click();
        await (await chooser).setFiles({
          name: "selected-processing.wav",
          mimeType: "audio/wav",
          buffer: silentWav(),
        });
        const processNew = page.getByRole("button", {
          name: /^Process new audio/,
        });
        await expect(processNew).toBeEnabled();
        expect(requests).toHaveLength(0);
        const ready = page.locator(".sys-prepare-ready");
        const readyHeading = ready.getByRole("heading", { level: 2 });
        await expect(readyHeading).toHaveCount(1);
        const summary = readyHeading.getByRole("button");
        if (profile.name === "phone") {
          await expect(summary).toBeVisible();
          await expect(summary.locator(".sys-prepare-summary-text")).toHaveText(
            "Getting ready: new audio waiting",
          );
          if ((await summary.getAttribute("aria-expanded")) === "false")
            await summary.click();
          await expect(summary).toHaveAttribute("aria-expanded", "true");
        } else {
          await expect(summary).toHaveCount(0);
          await expect(readyHeading).toHaveText("Getting ready");
        }
        for (const title of [
          "Transcribe",
          "Line up tracks",
          "Find suggestions",
        ]) {
          const row = ready
            .locator(".sys-status")
            .filter({ has: page.getByText(title, { exact: true }) });
          await expect(
            row.getByText("Off in Advanced", { exact: true }),
          ).toBeVisible();
          await expect(
            row.getByRole("button", { name: /^(Skip|Include),/ }),
          ).toHaveCount(0);
        }
        const before = processingProofProject(projectPath);
        const added = before.timeline.tracks.filter(
          (track) => !originalIds.has(track.id),
        );
        expect(added).toHaveLength(1);
        const newTrack = added[0]!;
        const beforeEffects =
          before.mix.processing_chains.find(
            (chain) => chain.track_id === newTrack.id,
          )?.effects ?? [];
        expect(
          beforeEffects.some((effect) => effect.effect === "highpass"),
        ).toBe(false);
        const clean = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Clean and level", { exact: true }) });
        await expect(
          clean.getByText(
            `All ${before.timeline.tracks.length} tracks · Clean`,
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          clean.getByRole("button", {
            name: "Skip, Clean and level",
            exact: true,
          }),
        ).toBeVisible();
        const proofDir = path.join(
          repoRoot,
          "gui/web/playwright-report",
          "prepare-selected-processing",
        );
        fs.mkdirSync(proofDir, { recursive: true });
        const proofName = `${profile.name}-${theme}-retry-${testInfo.retry}`;
        await dismissFeedbackToast(page);
        const stage = page.locator('[data-stage-host="prepare"]');
        await stage.evaluate((element) => {
          element.scrollTop = 0;
        });
        const transcribe = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Transcribe", { exact: true }) });
        const align = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Line up tracks", { exact: true }) });
        const suggest = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Find suggestions", { exact: true }) });
        const planTop = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-plan-top-viewport`,
          {
            heading: readyHeading,
            note: ready.locator(".sys-prepare-note"),
            added: ready.getByText("Add audio", { exact: true }),
            transcribe_title: transcribe.getByText("Transcribe", {
              exact: true,
            }),
            transcribe: transcribe.getByText("Off in Advanced", {
              exact: true,
            }),
            align: align.getByText("Off in Advanced", { exact: true }),
            clean: clean.getByText(
              `All ${before.timeline.tracks.length} tracks · Clean`,
              { exact: true },
            ),
            suggest: suggest.getByText("Off in Advanced", { exact: true }),
          },
        );
        await processNew.scrollIntoViewIfNeeded();
        await expect(processNew).toBeEnabled();
        const planHandoff = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-plan-handoff-viewport`,
          {
            process_new_audio: processNew,
          },
        );
        expect(requests).toHaveLength(0);
        const runResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/pipeline/run",
        );
        await processNew.click();
        const accepted = await runResponse;
        expect(accepted.ok()).toBe(true);
        const { job: acceptedJob } = (await accepted.json()) as {
          job: PipelineJobSnapshot;
        };
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          path: projectPath,
          enabled_steps: selected,
          use_working_set: true,
        });
        expect(requests[0]?.enabled_steps).toEqual(saved.enabled_steps);
        const requestedSkips = requests[0]?.skip_steps;
        expect(requestedSkips).toBeNull();
        let completed: PipelineJobSnapshot | undefined;
        await expect
          .poll(
            async () => {
              const response = await page.request.get("/api/pipeline/status");
              expect(response.ok()).toBe(true);
              const status = (await response.json()) as PipelineStatusResponse;
              completed =
                status.jobs?.find((job) => job.id === acceptedJob.id) ??
                (status.job?.id === acceptedJob.id ? status.job : undefined);
              return completed?.status ?? "missing";
            },
            {
              timeout: 45_000,
              message: "The real selected processing job completes",
            },
          )
          .toMatch(/^(ok|error|cancelled)$/);
        expect(completed?.status).toBe("ok");
        expect(
          completed?.steps.map((step) => ({
            name: step.name,
            status: step.status,
          })),
        ).toEqual(selected.map((name) => ({ name, status: "ok" })));
        const after = processingProofProject(projectPath);
        const afterEffects =
          after.mix.processing_chains.find(
            (chain) => chain.track_id === newTrack.id,
          )?.effects ?? [];
        expect(afterEffects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              effect: "highpass",
              params: { frequency: 80 },
            }),
          ]),
        );
        const retainedResponse = await page.request.get(
          `/api/pipeline/config?path=${encodeURIComponent(projectPath)}`,
        );
        expect(retainedResponse.ok()).toBe(true);
        const retained =
          (await retainedResponse.json()) as PipelineConfigResponse;
        expect(retained.enabled_steps).toEqual(selected);
        await expect(page.locator(".sys-prepare")).toHaveAttribute(
          "data-phase",
          "done",
        );
        await expect(
          page.getByRole("button", { name: /^Process new audio/ }),
        ).toHaveCount(0);
        const transcribeResult = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Transcribe", { exact: true }) });
        await expect(transcribeResult).toContainText(
          /Skipped this run|Not run this time/,
        );
        await expect(transcribeResult).not.toContainText("Transcribed");
        await expect(
          transcribeResult.getByRole("button", {
            name: /Download word timing/,
          }),
        ).toHaveCount(0);
        const alignResult = ready
          .locator(".sys-status")
          .filter({ has: page.getByText("Line up tracks", { exact: true }) });
        await expect(alignResult).toContainText(
          /Skipped this run|Not run this time/,
        );
        await expect(alignResult).not.toContainText("Lined up");
        if (profile.name === "phone") {
          await expect(summary).toBeVisible();
          await expect(summary.locator(".sys-prepare-summary-text")).toHaveText(
            "Getting ready: selected work finished",
          );
        }
        await dismissFeedbackToast(page);
        const resultHeading = profile.name === "phone" ? summary : readyHeading;
        if (
          profile.name === "phone" &&
          (await resultHeading.getAttribute("aria-expanded")) === "false"
        )
          await resultHeading.click();
        await resultHeading.scrollIntoViewIfNeeded();
        const resultStatus = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-selected-run-status-viewport`,
          { ready_heading_or_summary: resultHeading },
        );
        await transcribeResult.scrollIntoViewIfNeeded();
        const resultRows = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-selected-run-omitted-rows-viewport`,
          { transcribe_result: transcribeResult, align_result: alignResult },
        );
        const resultCopy = {
          phase: await page.locator(".sys-prepare").getAttribute("data-phase"),
          heading_or_summary: await resultHeading.innerText(),
          transcribe: await transcribeResult.innerText(),
          align: await alignResult.innerText(),
          process_new_audio_buttons: await processNew.count(),
          word_timing_buttons: await transcribeResult
            .getByRole("button", { name: /Download word timing/ })
            .count(),
        };
        await page.getByRole("button", { name: /^Advanced/ }).click();
        const sheet = page.getByRole("dialog", { name: "Advanced steps" });
        await dismissFeedbackToast(page);
        await scrollSheetTop(sheet);
        const sessionScope = sheet.getByText(
          /These switches affect runs started here.*until ShareCut restarts/,
        );
        await expect(sessionScope).toBeVisible();
        const session = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-session-top-viewport`,
          {
            session_scope: sessionScope,
          },
        );
        await sheet
          .getByRole("button", { name: /^Apply sound actions/ })
          .click();
        await dismissFeedbackToast(page);
        await scrollSheetTop(sheet);
        const soundHelper = sheet.getByText(
          /Applies suggested sound actions during processing/,
        );
        await expect(soundHelper).toBeVisible();
        const soundTop = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-sound-actions-top-viewport`,
          {
            title: sheet.getByRole("heading", {
              name: "Apply sound actions",
              exact: true,
            }),
            automatic_application: soundHelper,
          },
        );
        const preference = sheet.getByRole("group", {
          name: "New projects start with this",
        });
        const off = preference.getByRole("button", {
          name: "Off",
          exact: true,
        });
        const on = preference.getByRole("button", { name: "On", exact: true });
        const preferenceBefore = {
          off: await off.getAttribute("aria-pressed"),
          on: await on.getAttribute("aria-pressed"),
        };
        await off.focus();
        await expect(off).toBeFocused();
        const preferenceNote = sheet.getByText(
          /Saved in this browser for new episodes.*resets to its default when ShareCut restarts/,
        );
        await expect(preferenceNote).toBeVisible();
        await expect(preferenceNote).toHaveCSS("clip-path", "none");
        const field = sheet.locator(".sys-adv-field").filter({
          has: page.getByRole("group", {
            name: "New projects start with this",
            exact: true,
          }),
        });
        await field.scrollIntoViewIfNeeded();
        await expect(off).toBeFocused();
        const preferenceAfter = {
          off: await off.getAttribute("aria-pressed"),
          on: await on.getAttribute("aria-pressed"),
        };
        expect(preferenceAfter).toEqual(preferenceBefore);
        const preferenceBottom = await captureViewport(
          page,
          testInfo,
          proofDir,
          `${proofName}-sound-preference-bottom-viewport`,
          {
            full_preference_field: field,
            off,
            on,
            reset_note: preferenceNote,
          },
        );
        const receipt = {
          scope:
            "Real selected ingest and high-pass processing only; no transcription, listening or full-pipeline acceptance claim",
          profile: profile.name,
          browser: browserName,
          viewport: page.viewportSize(),
          theme,
          configured_steps: saved.enabled_steps,
          request: {
            enabled_steps: requests[0]?.enabled_steps,
            skip_steps: requestedSkips ?? null,
            use_working_set: requests[0]?.use_working_set,
          },
          job: {
            id: completed?.id,
            status: completed?.status,
            steps: completed?.steps,
          },
          new_track_id: newTrack.id,
          before_effects: beforeEffects,
          after_effects: afterEffects,
          retained_steps: retained.enabled_steps,
          selected_run_result: resultCopy,
          captures: {
            plan_top: planTop,
            plan_handoff: planHandoff,
            selected_run_status: resultStatus,
            selected_run_omitted_rows: resultRows,
            session_top: session,
            sound_top: soundTop,
            focused_preference_bottom: preferenceBottom,
          },
          preference_focus: {
            target: "Off",
            before: preferenceBefore,
            after: preferenceAfter,
          },
        };
        const receiptPath = path.join(proofDir, `${proofName}-receipt.json`);
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        await testInfo.attach("selected-processing-receipt", {
          path: receiptPath,
          contentType: "application/json",
        });
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
      });
    });
  }
}
