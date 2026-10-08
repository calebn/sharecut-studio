import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type CDPSession,
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  type TestInfo,
} from "@playwright/test";
import {
  createEditingFixture,
  readEditingHistory,
  readEditingState,
  verifyEditingBackend,
} from "./editingTaskEvidence";
import {
  navigateEditingTimeline,
  performEditingInput,
} from "./editingTaskInputs";
import {
  assessEditingTrial,
  type EditingTrial,
  type JournalEvent,
  type Phase,
  savedStateDifferences,
  type TaskDefinition,
} from "./editingTaskReport";
import { createEditorProfiler } from "./editorProfile";
import { switchE2eProject } from "./shareableProject";

export async function editingResponseBody(response: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Editing response body drain timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function editingResponseOutcome(
  response: Response,
  request: { id: number; phase: Phase; kind: "command" | "read" },
) {
  try {
    const body = await editingResponseBody(response);
    return {
      phase: request.phase,
      kind:
        request.kind === "read"
          ? ("read-response" as const)
          : ("response" as const),
      requestId: request.id,
      status: response.status(),
      body,
    };
  } catch (error) {
    return request.kind === "read"
      ? {
          phase: request.phase,
          kind: "read-body-failed" as const,
          requestId: request.id,
          status: response.status(),
          error: String(error),
        }
      : {
          phase: request.phase,
          kind: "error" as const,
          message: `response ${request.id}: ${String(error)}`,
        };
  }
}
export async function runEditingTask(
  page: Page,
  cdp: CDPSession,
  info: TestInfo,
  task: TaskDefinition,
  routeId: string,
  output: string,
  mode: EditingTrial["mode"],
): Promise<EditingTrial> {
  const chosen = task.routes.find((row) => row.id === routeId);
  if (!chosen || "pending" in chosen)
    throw new Error("Only current supported routes can execute");
  fs.mkdirSync(output, { recursive: true });
  const trial: EditingTrial = {
    task: task.id,
    route: routeId,
    mode,
    journal: [],
    errors: [],
    protocolHash: process.env.EDITING_PROTOCOL_HASH,
    definitionHash: createHash("sha256")
      .update(JSON.stringify(task))
      .digest("hex"),
    role: "host",
    artifacts: [],
  };
  let phase: Phase = "setup";
  let sequence = 0;
  const retain = () =>
    fs.writeFileSync(
      path.join(output, "trial.json"),
      `${JSON.stringify(trial, null, 2)}\n`,
    );
  const captureUi = async (active: Page, stage: string, screenshot = true) => {
    const geometry = await active
      .locator(
        '[data-clip-id], [role="slider"], input[type="range"], .comment-card, svg circle',
      )
      .evaluateAll((elements) => ({
        focused: {
          tag: document.activeElement?.tagName ?? null,
          label: document.activeElement?.getAttribute("aria-label") ?? null,
          className: document.activeElement?.getAttribute("class") ?? null,
        },
        elements: elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.getAttribute("data-clip-id"),
            label: element.getAttribute("aria-label"),
            value:
              element.getAttribute("aria-valuenow") ??
              (element instanceof HTMLInputElement ? element.value : null),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            transform: element.getAttribute("style"),
          };
        }),
      }));
    const evidence: NonNullable<EditingTrial["uiEvidence"]>[number] = {
      stage,
      phase,
      geometry,
    };
    if (mode !== "baseline" && screenshot) {
      evidence.screenshot = `ui-${trial.uiEvidence?.length ?? 0}-${stage}.png`;
      await active.screenshot({
        path: path.join(output, evidence.screenshot),
        fullPage: true,
      });
      trial.artifacts!.push(evidence.screenshot);
    }
    (trial.uiEvidence ??= []).push(evidence);
    retain();
  };
  const append = (
    event:
      | { kind: "error"; message: string }
      | { kind: "request"; requestId: number; type: string; body: string }
      | { kind: "read-request"; requestId: number; url: string; method: string }
      | {
          kind: "read-response";
          requestId: number;
          status: number;
          body: string;
        }
      | { kind: "read-failed"; requestId: number; error: string },
  ) => {
    trial.journal.push({ ...event, seq: ++sequence, phase } as JournalEvent);
    retain();
  };
  const responses: Promise<void>[] = [];
  const pending = new Map<Page, Set<Request>>();
  const flush = async (active: Page) => {
    try {
      await active.waitForLoadState("networkidle", { timeout: 5000 });
      await expect
        .poll(() => pending.get(active)?.size ?? 0, {
          timeout: 5000,
          message: "Pending editing requests did not reach terminal outcomes",
        })
        .toBe(0);
    } finally {
      await Promise.all(responses);
    }
  };
  const observe = (observedPage: Page) => {
    const inflight = new Set<Request>();
    pending.set(observedPage, inflight);
    observedPage.on("requestfinished", (request) => inflight.delete(request));
    const requests = new Map<
      Request,
      { id: number; phase: Phase; kind: "command" | "read" }
    >();
    observedPage.on("pageerror", (error) =>
      append({ kind: "error", message: error.message }),
    );
    observedPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.startsWith("/api/")
      ) {
        const id = sequence + 1;
        requests.set(request, { id, phase, kind: "read" });
        inflight.add(request);
        append({
          kind: "read-request",
          requestId: id,
          url: request.url(),
          method: request.method(),
        });
        return;
      }
      if (
        request.method() !== "POST" ||
        !new URL(request.url()).pathname.includes("/document/command")
      )
        return;
      const body = request.postData() ?? "";
      let type = "unknown";
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        )
          throw new Error("Expected saved object");
        const command = parsed as Record<string, unknown>;
        type = typeof command.type === "string" ? command.type : "unknown";
      } catch {}
      const id = sequence + 1;
      requests.set(request, { id, phase, kind: "command" });
      inflight.add(request);
      append({ kind: "request", requestId: id, type, body });
    });
    observedPage.on("response", (response) => {
      const url = new URL(response.url());
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        response.status() >= 400
      ) {
        append({
          kind: "error",
          message: `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
        });
        responses.push(
          editingResponseBody(response)
            .then((body) =>
              append({
                kind: "error",
                message: `HTTP error body ${response.url()} ${body}`,
              }),
            )
            .catch((error) =>
              append({
                kind: "error",
                message: `HTTP error body unavailable ${response.url()} ${String(error)}`,
              }),
            ),
        );
      }
      const request = requests.get(response.request());
      if (!request) return;
      responses.push(
        editingResponseOutcome(response, request).then((outcome) => {
          trial.journal.push({ ...outcome, seq: ++sequence });
          retain();
        }),
      );
    });
    observedPage.on("requestfailed", (request) => {
      inflight.delete(request);
      const read = requests.get(request);
      if (read?.kind === "read") {
        trial.journal.push({
          seq: ++sequence,
          phase: read.phase,
          kind: "read-failed",
          requestId: read.id,
          error: request.failure()?.errorText ?? "unknown",
        });
        retain();
        return;
      }
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(request.url()).hostname,
        )
      )
        append({
          kind: "error",
          message: `request failed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
        });
    });
  };
  const act = async (
    verb: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const event: JournalEvent = {
      seq: ++sequence,
      phase,
      kind: "activation",
      verb,
      label,
      outcome: "started",
    };
    trial.journal.push(event);
    retain();
    try {
      await action();
      event.outcome = "completed";
    } catch (error) {
      event.outcome = "failed";
      event.error = String(error);
      throw error;
    } finally {
      retain();
    }
  };
  const click = (control: Locator, label: string) =>
    act("click", label, () => control.click());
  const key = (active: Page, value: string) =>
    act("key", value, () => active.keyboard.press(value));
  const focus = (control: Locator, label: string) =>
    act("focus", label, () => control.focus());
  const prepare = async (active: Page, projectPath: string) => {
    phase = "setup";
    await active.setViewportSize(task.viewport);
    await active.emulateMedia({
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    await switchE2eProject(projectPath);
    await active.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await expect(active.locator(".daw-shell")).toBeVisible();
    await active.waitForLoadState("networkidle");
    await active.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    await navigateEditingTimeline(active, click);
    await captureUi(active, "timeline-ready");
    await act("click", "prepare timeline focus", () =>
      active.locator(".timeline-scroll").click({ position: { x: 2, y: 2 } }),
    );
    await act("key", "prepare fixed zoom one step", () =>
      active.keyboard.press("="),
    );
  };
  const inputRecorder = {
    act,
    captureUi,
    waitForActionResponses: async (count: number) => {
      await expect
        .poll(
          () =>
            trial.journal.filter(
              (row) => row.kind === "response" && row.phase === "action",
            ).length,
        )
        .toBe(count);
    },
  };
  let fixture: ReturnType<typeof createEditingFixture>;
  try {
    fixture = createEditingFixture(task, output);
  } catch (error) {
    trial.errors!.push(`fixture: ${String(error)}`);
    retain();
    throw error;
  }
  trial.fixture = {
    projectPath: fixture.projectPath,
    savedHash: createHash("sha256")
      .update(JSON.stringify(readEditingState(fixture.projectPath)))
      .digest("hex"),
    media: Object.fromEntries(
      ["reference", "guest"].map((id) => [
        id,
        createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(fixture.workspaceDir, "raw", `${id}.wav`),
            ),
          )
          .digest("hex"),
      ]),
    ),
  };
  const history = () => readEditingHistory(fixture.projectPath);
  trial.history = { before: history(), after: null, undone: null };
  fs.copyFileSync(
    fixture.projectPath,
    path.join(output, "initial-project.json"),
  );
  const profiler = await createEditorProfiler(
    page,
    cdp,
    info,
    fixture.projectPath,
    0,
    true,
  );
  observe(page);
  try {
    if (chosen.cancel) {
      const canceledFixture = createEditingFixture(task, output);
      let activeCancelFixture = canceledFixture;
      const context = await page
        .context()
        .browser()!
        .newContext({
          viewport: task.viewport,
          hasTouch: chosen.input === "cdp-touch" || task.id === "mix",
        });
      const cancelPage = await context.newPage();
      const cancelCdp = await context.newCDPSession(cancelPage);
      observe(cancelPage);
      try {
        const probes =
          task.id === "comment"
            ? ["short", "vertical", "touch-cancel"]
            : ["cancel"];
        for (const [index, probe] of probes.entries()) {
          const clone =
            index === 0 ? canceledFixture : createEditingFixture(task, output);
          activeCancelFixture = clone;
          fs.copyFileSync(
            clone.projectPath,
            path.join(output, `canceled-${probe}-initial-project.json`),
          );
          await prepare(cancelPage, clone.projectPath);
          phase = "cancel";
          await captureUi(cancelPage, `cancel-${probe}-initiation`);
          await performEditingInput(
            {
              active: cancelPage,
              session: cancelCdp,
              task,
              route: chosen,
              cancel: true,
              cancelProbe: probe,
            },
            inputRecorder,
          );
          await flush(cancelPage);
          await captureUi(cancelPage, `cancel-${probe}-recovery`);
          trial.canceled = readEditingState(clone.projectPath);
          (trial.cancellations ??= []).push({ probe, state: trial.canceled });
          fs.copyFileSync(
            clone.projectPath,
            path.join(output, `canceled-${probe}-project.json`),
          );
          retain();
        }
      } catch (error) {
        trial.errors!.push(`cancel: ${String(error)}`);
        trial.canceled = readEditingState(activeCancelFixture.projectPath);
        fs.copyFileSync(
          activeCancelFixture.projectPath,
          path.join(output, "failed-cancel-project.json"),
        );
        await captureUi(cancelPage, "failed-cancel-recovery");
        retain();
      } finally {
        await flush(cancelPage).catch((error) =>
          trial.errors!.push(`cancel response drain: ${String(error)}`),
        );
        await context.close();
      }
    }
    await prepare(page, fixture.projectPath);
    verifyEditingBackend(output, process.env.DAW_E2E_PORT, {
      cwd: path.resolve("../.."),
      productionDist: process.env.PODCAST_GUI_DIST,
      shareRegistry: process.env.PODCAST_SHARE_REGISTRY,
    });
    await page.screenshot({
      path: path.join(output, "before.png"),
      fullPage: true,
    });
    trial.artifacts!.push("before.png");
    trial.before = readEditingState(fixture.projectPath);
    retain();
    phase = "action";
    await captureUi(page, "initiation");
    const measureAction = () =>
      profiler.measure(
        {
          id: `editing-${task.id}-${routeId}`,
          phase: "warm",
          input: `${chosen.input} current-main editing task`,
        },
        async () => {
          await performEditingInput(
            { active: page, session: cdp, task, route: chosen, cancel: false },
            inputRecorder,
          );
          await captureUi(page, "input-complete");
          await expect
            .poll(() =>
              savedStateDifferences(
                task.expected,
                readEditingState(fixture.projectPath, task.id === "range-cut"),
                "after",
                chosen.input === "pointer" || chosen.input === "cdp-touch"
                  ? task.tolerances
                  : Object.fromEntries(
                      Object.keys(task.tolerances).map((key) => [key, 1e-6]),
                    ),
              ),
            )
            .toEqual([]);
          trial.after = readEditingState(
            fixture.projectPath,
            task.id === "range-cut",
          );
          if (task.seek !== undefined)
            trial.transport = {
              seconds: Number(
                await page
                  .getByRole("slider", { name: "Timeline position" })
                  .getAttribute("aria-valuenow"),
              ),
              playing: await page
                .getByRole("button", { name: "Pause", exact: true })
                .isVisible(),
            };
          retain();
          return {
            kind: "existing",
            contract: path.join(output, "trial.json"),
          };
        },
      );
    if (mode === "diagnostic")
      await profiler.trace(async () => {
        await measureAction();
      });
    else await measureAction();
    trial.durationMs = profiler.report.samples[0]?.driverWallMs;
    await flush(page);
    trial.history!.after = history();
    fs.copyFileSync(
      fixture.projectPath,
      path.join(output, "committed-project.json"),
    );
    await page.screenshot({
      path: path.join(output, "saved.png"),
      fullPage: true,
    });
    trial.artifacts!.push("saved.png");
    await captureUi(page, "saved");
    phase = "undo";
    if (chosen.undo === "comment-toast")
      await click(
        page
          .locator(".comments-panel .ui-toast")
          .getByRole("button", { name: "Undo", exact: true }),
        "comment toast Undo",
      );
    if (chosen.undo === "history") {
      if (task.viewport.width < 720)
        await click(
          page
            .getByRole("dialog", { name: "Mix", exact: true })
            .getByRole("button", { name: "Close", exact: true }),
          "Close Mix",
        );
      await focus(
        page.getByRole("button", { name: "Menu", exact: true }),
        "non-typing Menu",
      );
      for (let index = 0; index < chosen.mutations; index++) {
        await key(page, "ControlOrMeta+z");
        await expect
          .poll(
            () =>
              trial.journal.filter(
                (row) => row.kind === "response" && row.phase === "undo",
              ).length,
          )
          .toBe(index + 1);
      }
    }
    if (chosen.undo !== "none") {
      await expect
        .poll(() => readEditingState(fixture.projectPath))
        .toEqual(task.start);
      await flush(page);
      trial.undone = readEditingState(fixture.projectPath);
      trial.history!.undone = history();
      fs.copyFileSync(
        fixture.projectPath,
        path.join(output, "undone-project.json"),
      );
      await page.screenshot({
        path: path.join(output, "undone.png"),
        fullPage: true,
      });
      trial.artifacts!.push("undone.png");
      await captureUi(page, "undo-recovery");
    }
  } catch (error) {
    trial.errors!.push(String(error));
    await page
      .screenshot({ path: path.join(output, "failed.png"), fullPage: true })
      .catch(() => {});
    trial.artifacts!.push("failed.png");
    try {
      trial.after ??= readEditingState(
        fixture.projectPath,
        task.id === "range-cut",
      );
    } catch (error) {
      trial.errors!.push(`saved state: ${String(error)}`);
    }
  } finally {
    await flush(page).catch((error) =>
      trial.errors!.push(`main response drain: ${String(error)}`),
    );
    await profiler.finish();
    trial.profiler = process.env.DAW_PROFILE_OUT
      ? path.join(process.env.DAW_PROFILE_OUT, "report.json")
      : info.outputPath("editor-profile", "report.json");
    const identities: Record<string, string> = {};
    try {
      readEditingState(
        fixture.projectPath,
        task.id === "range-cut",
        identities,
      );
    } catch (error) {
      trial.errors!.push(`identity map: ${String(error)}`);
    }
    fs.writeFileSync(
      path.join(output, "clip-identities.json"),
      JSON.stringify(identities, null, 2),
    );
    fs.copyFileSync(
      fixture.projectPath,
      path.join(output, "saved-project.json"),
    );
    retain();
    fs.writeFileSync(
      path.join(output, "assessment.json"),
      JSON.stringify(assessEditingTrial(task, trial), null, 2),
    );
  }
  return trial;
}
