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
  type EvidenceOrigin,
  type FailureOwner,
  type JournalEvent,
  type TaskDefinition,
} from "./editingTaskReport";
import { savedStateDifferences } from "./editingTaskState";
import { createEditorProfiler } from "./editorProfile";
import { switchE2eProject } from "./shareableProject";
import { withBrowserPages } from "./twoBrowserPages";

function nativeErrorName(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : null;
}
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
  request: { id: number; origin: EvidenceOrigin; kind: "command" | "read" },
) {
  const origin = { ...request.origin };
  const { id, kind } = request;
  const status = response.status();
  try {
    const body = await editingResponseBody(response);
    return {
      ...origin,
      kind:
        kind === "read" ? ("read-response" as const) : ("response" as const),
      requestId: id,
      status,
      body,
    };
  } catch (error) {
    return {
      ...origin,
      kind:
        kind === "read"
          ? ("read-body-failed" as const)
          : ("command-body-failed" as const),
      requestId: id,
      status,
      error: String(error),
      errorName: nativeErrorName(error),
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
    failures: [],
    cancellations: [],
    protocolHash: process.env.EDITING_PROTOCOL_HASH,
    definitionHash: createHash("sha256")
      .update(JSON.stringify(task))
      .digest("hex"),
    role: "host",
    artifacts: [],
  };
  let mainOrigin: EvidenceOrigin = { owner: "main", phase: "setup" };
  let cancelOrigin: EvidenceOrigin = mainOrigin;
  let origin: EvidenceOrigin = mainOrigin;
  const pageOrigins = new Map<Page, () => EvidenceOrigin>([
    [page, () => mainOrigin],
  ]);
  const handledFailures = new Set<unknown>();
  const fail = (error: unknown, owner: FailureOwner, prefix = "") => {
    if (!handledFailures.has(error))
      trial.failures.push({
        origin: owner,
        error: prefix + String(error),
        errorName: nativeErrorName(error),
      });
  };
  let sequence = 0;
  const retain = () => {
    try {
      fs.writeFileSync(
        path.join(output, "trial.json"),
        `${JSON.stringify(trial, null, 2)}\n`,
      );
    } catch (error) {
      fail(
        error,
        { owner: "global", blocks: "all-proofs" },
        "trial retention: ",
      );
      handledFailures.add(error);
      throw error;
    }
  };
  const captureUi = async (active: Page, stage: string, screenshot = true) => {
    const capturedOrigin = { ...pageOrigins.get(active)!() };
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
      origin: capturedOrigin,
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
    eventOrigin: EvidenceOrigin,
  ) => {
    trial.journal.push({
      ...event,
      seq: ++sequence,
      ...eventOrigin,
    } as JournalEvent);
    retain();
  };
  const observe = (observedPage: Page, getOrigin: () => EvidenceOrigin) => {
    const awaitingTerminal = new Set<Request>();
    const bodies = new Map<Promise<void>, EvidenceOrigin>();
    const requests = new Map<
      Request,
      { id: number; origin: EvidenceOrigin; kind: "command" | "read" }
    >();
    const recordBody = (
      bodyOrigin: EvidenceOrigin,
      operation: () => Promise<void>,
    ) => {
      const body = Promise.resolve()
        .then(operation)
        .catch((error) =>
          fail(
            error,
            { owner: "global", blocks: "all-proofs" },
            "response journal: ",
          ),
        )
        .then(() => {
          bodies.delete(body);
        });
      bodies.set(body, bodyOrigin);
    };
    const onPageError = (error: Error) =>
      append({ kind: "error", message: error.message }, getOrigin());
    const onRequest = (request: Request) => {
      const admittedOrigin = { ...getOrigin() };
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.pathname.startsWith("/api/")
      ) {
        const id = sequence + 1;
        requests.set(request, { id, origin: admittedOrigin, kind: "read" });
        awaitingTerminal.add(request);
        append(
          {
            kind: "read-request",
            requestId: id,
            url: request.url(),
            method: request.method(),
          },
          admittedOrigin,
        );
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
      requests.set(request, { id, origin: admittedOrigin, kind: "command" });
      awaitingTerminal.add(request);
      append({ kind: "request", requestId: id, type, body }, admittedOrigin);
    };
    const onResponse = (response: Response) => {
      const origin = requests.get(response.request());
      const responseOrigin = origin?.origin ?? getOrigin();
      const url = new URL(response.url());
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        response.status() >= 400
      ) {
        append(
          {
            kind: "error",
            message: `HTTP ${response.status()} ${response.request().method()} ${response.url()}`,
          },
          responseOrigin,
        );
        recordBody(responseOrigin, () =>
          editingResponseBody(response)
            .then((body) =>
              append(
                {
                  kind: "error",
                  message: `HTTP error body ${response.url()} ${body}`,
                },
                responseOrigin,
              ),
            )
            .catch((error) =>
              append(
                {
                  kind: "error",
                  message: `HTTP error body unavailable ${response.url()} ${String(error)}`,
                },
                responseOrigin,
              ),
            ),
        );
      }
      const request = requests.get(response.request());
      if (!request) return;
      recordBody(request.origin, () =>
        editingResponseOutcome(response, request).then((outcome) => {
          trial.journal.push({ ...outcome, seq: ++sequence });
          retain();
          awaitingTerminal.delete(response.request());
        }),
      );
    };
    const onRequestFailed = (request: Request) => {
      const read = requests.get(request);
      if (read?.kind === "read") {
        trial.journal.push({
          seq: ++sequence,
          ...read.origin,
          kind: "read-failed",
          requestId: read.id,
          error: request.failure()?.errorText ?? "unknown",
        });
        retain();
        awaitingTerminal.delete(request);
        return;
      }
      if (
        ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(request.url()).hostname,
        )
      )
        append(
          {
            kind: "error",
            message: `request failed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
          },
          read?.origin ?? getOrigin(),
        );
      awaitingTerminal.delete(request);
    };
    const detach = () => {
      observedPage.off("request", onRequest);
      observedPage.off("response", onResponse);
      observedPage.off("requestfailed", onRequestFailed);
      observedPage.off("pageerror", onPageError);
    };
    const drain = async (finish: boolean) => {
      const prefix =
        getOrigin().owner === "main"
          ? "main response drain: "
          : "cancel response drain: ";
      try {
        await observedPage.waitForLoadState("networkidle", { timeout: 5000 });
        await expect
          .poll(
            () => {
              const pending = awaitingTerminal.size + bodies.size;
              if (pending === 0 && finish) detach();
              return pending;
            },
            {
              timeout: 5000,
              message:
                "Pending editing requests did not reach terminal outcomes",
            },
          )
          .toBe(0);
      } catch (error) {
        if (finish) detach();
        const pendingOrigins = [...bodies.values()];
        const unresolved = [...awaitingTerminal].flatMap((request) => {
          const retained = requests.get(request);
          return retained ? [retained.origin] : [];
        });
        const knownOrigins = [...unresolved, ...pendingOrigins].filter(
          (item, index, rows) =>
            rows.findIndex(
              (row) => JSON.stringify(row) === JSON.stringify(item),
            ) === index,
        );
        if (knownOrigins.length)
          for (const retained of knownOrigins) fail(error, retained, prefix);
        else fail(error, { owner: "global", blocks: "all-proofs" }, prefix);
        handledFailures.add(error);
        await Promise.allSettled(bodies.keys());
        throw error;
      }
    };
    observedPage.on("request", onRequest);
    observedPage.on("response", onResponse);
    observedPage.on("requestfailed", onRequestFailed);
    observedPage.on("pageerror", onPageError);
    return { flush: () => drain(false), finish: () => drain(true) };
  };
  const act = async (
    verb: string,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const event: JournalEvent = {
      seq: ++sequence,
      ...origin,
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
  const prepare = async (
    active: Page,
    projectPath: string,
    setupOrigin: EvidenceOrigin,
  ) => {
    origin = setupOrigin;
    if (origin.owner === "main") mainOrigin = origin;
    else cancelOrigin = origin;
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
    fail(error, mainOrigin, "fixture: ");
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
  const mainObservation = observe(page, () => mainOrigin);
  try {
    if (chosen.cancellation.length) {
      cancelOrigin = {
        owner: "cancel",
        phase: "setup",
        probe: chosen.cancellation[0].id,
      };
      origin = cancelOrigin;
      let activeCancelFixture:
        | ReturnType<typeof createEditingFixture>
        | undefined;
      let cancellationOutcome: "completed" | "failed" | undefined;
      const retainCancellationFailure = (error: unknown) => {
        const failedOrigin = cancelOrigin;
        fail(error, failedOrigin, "cancel: ");
        let state: EditingTrial["cancellations"][number]["state"] = null;
        if (activeCancelFixture) {
          try {
            state = readEditingState(activeCancelFixture.projectPath);
          } catch (stateError) {
            fail(stateError, failedOrigin, "cancel recovery state: ");
          }
          fs.copyFileSync(
            activeCancelFixture.projectPath,
            path.join(output, "failed-cancel-project.json"),
          );
        }
        if (
          failedOrigin.owner === "cancel" &&
          !trial.cancellations.some((row) => row.probe === failedOrigin.probe)
        )
          trial.cancellations.push({
            probe: failedOrigin.probe,
            outcome: "failed",
            state,
          });
        retain();
      };
      try {
        const canceledFixture = createEditingFixture(task, output);
        activeCancelFixture = canceledFixture;
        await withBrowserPages(
          page.context().browser()!,
          [
            {
              viewport: task.viewport,
              hasTouch: chosen.input === "cdp-touch" || task.id === "mix",
            },
          ],
          async ([cancelPage]) => {
            pageOrigins.set(cancelPage, () => cancelOrigin);
            let cancelObservation: ReturnType<typeof observe> | undefined;
            try {
              const cancelCdp = await cancelPage
                .context()
                .newCDPSession(cancelPage);
              cancelObservation = observe(cancelPage, () => cancelOrigin);
              for (const [index, recipe] of chosen.cancellation.entries()) {
                const probe = recipe.id;
                cancelOrigin = { owner: "cancel", phase: "setup", probe };
                origin = cancelOrigin;
                const clone =
                  index === 0
                    ? canceledFixture
                    : createEditingFixture(task, output);
                activeCancelFixture = clone;
                fs.copyFileSync(
                  clone.projectPath,
                  path.join(output, `canceled-${probe}-initial-project.json`),
                );
                await prepare(cancelPage, clone.projectPath, cancelOrigin);
                cancelOrigin = { owner: "cancel", phase: "cancel", probe };
                origin = cancelOrigin;
                await captureUi(cancelPage, `cancel-${probe}-initiation`);
                await performEditingInput(
                  {
                    active: cancelPage,
                    session: cancelCdp,
                    task,
                    route: chosen,
                    intent: { kind: "cancel", probe: recipe },
                  },
                  inputRecorder,
                );
                await cancelObservation.flush();
                await captureUi(cancelPage, `cancel-${probe}-recovery`);
                trial.cancellations.push({
                  probe,
                  outcome: "completed",
                  state: readEditingState(clone.projectPath),
                });
                fs.copyFileSync(
                  clone.projectPath,
                  path.join(output, `canceled-${probe}-project.json`),
                );
                retain();
              }
              cancellationOutcome = "completed";
            } catch (error) {
              cancellationOutcome = "failed";
              try {
                retainCancellationFailure(error);
                if (cancelObservation)
                  await captureUi(cancelPage, "failed-cancel-recovery");
              } catch (recoveryError) {
                fail(
                  recoveryError,
                  { owner: "global", blocks: "all-proofs" },
                  "cancel recovery retention: ",
                );
              }
              throw error;
            } finally {
              await cancelObservation
                ?.finish()
                .catch((error) =>
                  fail(error, cancelOrigin, "cancel response drain: "),
                );
            }
          },
          (error) => {
            fail(
              error,
              { owner: "cancel", phase: "cancel", probe: null },
              "cancel context close: ",
            );
          },
        );
      } catch (error) {
        if (cancellationOutcome === undefined) {
          cancellationOutcome = "failed";
          retainCancellationFailure(error);
        }
      }
    }
    origin = mainOrigin;
    await prepare(page, fixture.projectPath, mainOrigin);
    try {
      verifyEditingBackend(output, process.env.DAW_E2E_PORT, {
        cwd: path.resolve("../.."),
        productionDist: process.env.PODCAST_GUI_DIST,
        shareRegistry: process.env.PODCAST_SHARE_REGISTRY,
      });
    } catch (error) {
      fail(error, { owner: "global", blocks: "all-proofs" });
      handledFailures.add(error);
      throw error;
    }
    await page.screenshot({
      path: path.join(output, "before.png"),
      fullPage: true,
    });
    trial.artifacts!.push("before.png");
    trial.before = readEditingState(fixture.projectPath);
    retain();
    mainOrigin = { owner: "main", phase: "action" };
    origin = mainOrigin;
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
            {
              active: page,
              session: cdp,
              task,
              route: chosen,
              intent: { kind: "action" },
            },
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
    await mainObservation.flush();
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
    mainOrigin = { owner: "main", phase: "undo" };
    origin = mainOrigin;
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
      await mainObservation.flush();
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
    const failedOrigin = origin;
    fail(error, failedOrigin);
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
      fail(error, failedOrigin, "saved state: ");
    }
  } finally {
    try {
      await profiler
        .finish()
        .catch((error) =>
          fail(error, { owner: "global", blocks: "admission" }, "profiler: "),
        );
    } finally {
      await mainObservation.finish().catch((error) => {
        fail(error, mainOrigin, "main response drain: ");
        retain();
      });
    }
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
      fail(error, { owner: "global", blocks: "all-proofs" }, "identity map: ");
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
