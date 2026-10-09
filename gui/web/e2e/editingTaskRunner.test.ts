import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  assessEditingTrial,
  type HistoryIdentity,
  type TaskDefinition,
} from "./editingTaskReport";
import type { DurableState } from "./editingTaskState";
import { runEditingTask } from "./editingTasks";

const simulation = vi.hoisted(() => ({
  fixture: { projectPath: "", workspaceDir: "" },
  fixtureSequence: [] as (
    | { projectPath: string; workspaceDir: string }
    | Error
  )[],
  captureWrongPage: false,
  states: new Map<string, DurableState>(),
  state: undefined as DurableState | undefined,
  history: undefined as HistoryIdentity | undefined,
  readState: undefined as
    | typeof import("./editingTaskEvidence").readEditingState
    | undefined,
  persistState: undefined as ((state: DurableState) => void) | undefined,
}));
vi.mock("./editingBackendIdentity", () => ({
  verifyEditingBackend: async (
    _attempt: string,
    _port: string,
    input: { phase: "before" | "after" },
  ) => ({
    phase: input.phase,
    protocolHash: "controlled",
    pid: 1,
    startTime: "1",
    listenerInode: "1",
    receiptHash: "controlled",
    launchHash: "controlled",
    verificationHash: "controlled",
  }),
}));
vi.mock("./editingTaskEvidence", () => ({
  createEditingFixture: () => {
    const next = simulation.fixtureSequence.shift();
    if (next instanceof Error) throw next;
    return next ?? simulation.fixture;
  },
  readEditingState: (
    ...args: Parameters<typeof import("./editingTaskEvidence").readEditingState>
  ) =>
    simulation.readState
      ? simulation.readState(...args)
      : (simulation.states.get(args[0]) ?? simulation.state),
  readEditingHistory: () => simulation.history,
}));
vi.mock("./shareableProject", () => ({ switchE2eProject: async () => {} }));
vi.mock("./editingTaskInputs", () => ({
  navigateEditingTimeline: async () => {},
  performEditingInput: async (
    context: {
      active: EventEmitter;
      task: TaskDefinition;
      route: { command: string | null };
      intent: { kind: "action" | "cancel"; probe?: { id: string } };
    },
    recorder: {
      captureUi(active: Page, stage: string): Promise<void>;
      act(
        verb: string,
        label: string,
        action: () => Promise<void>,
      ): Promise<void>;
    },
  ) => {
    if (simulation.captureWrongPage)
      await recorder.captureUi({} as Page, "literal unregistered-page");
    if (context.intent.kind === "cancel")
      return recorder.act(
        "key",
        `literal ${context.intent.probe!.id} cancellation`,
        async () => {},
      );
    return recorder.act("key", "literal saved edit", async () => {
      const request = {
        url: () => "http://localhost/api/document/command",
        method: () => "POST",
        postData: () => JSON.stringify({ type: context.route.command }),
      };
      context.active.emit("request", request);
      context.active.emit("response", {
        url: request.url,
        request: () => request,
        status: () => 200,
        text: async () => '{"ok":true,"type":"Applied"}',
      });
      simulation.state = context.task.expected;
      simulation.persistState?.(context.task.expected);
      simulation.history = {
        cursor: 1,
        headId: "changed",
        entries: [
          {
            id: "baseline",
            label: context.task.historyLabels!.before,
            operation: null,
          },
          {
            id: "changed",
            label: context.task.historyLabels!.after,
            operation: context.task.historyOperation ?? null,
          },
        ],
      };
    });
  },
}));
vi.mock("./editorProfile", () => ({
  createEditorProfiler: async () => ({
    report: { samples: [{ driverWallMs: 1 }] },
    measure: async (_: unknown, action: () => Promise<unknown>) => action(),
    finish: async () => {},
  }),
}));
const roots: string[] = [];
afterEach(() => {
  simulation.captureWrongPage = false;
  simulation.readState = undefined;
  simulation.persistState = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function runner(failedPhase: "action" | "undo" | null, taskId = "trim") {
  simulation.fixtureSequence = [];
  simulation.states.clear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editing-runner-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "raw"));
  for (const id of ["reference", "guest"])
    fs.writeFileSync(path.join(root, `raw/${id}.wav`), `${id} bytes`);
  simulation.fixture = {
    projectPath: path.join(root, "episode.project.json"),
    workspaceDir: root,
  };
  fs.writeFileSync(simulation.fixture.projectPath, "{}");
  const registered = editingTaskRegistry.find((row) => row.id === taskId)!;
  const registeredRoute = registered.routes[0];
  if ("pending" in registeredRoute)
    throw new Error("literal runner route must be supported");
  const task: TaskDefinition = {
    ...registered,
    routes: [
      {
        id: "literal-runner",
        input: "keyboard",
        command: registeredRoute.command,
        mutations: 1,
        cancellation: [],
        undo: "history",
      },
    ],
  };
  simulation.state = task.start;
  simulation.history = { cursor: -1, headId: null, entries: [] };
  let rejectBody!: (error: Error) => void;
  const body = new Promise<string>((_, reject) => {
    rejectBody = reject;
  });
  let bodyRequested!: () => void;
  const bodyReady = new Promise<void>((resolve) => {
    bodyRequested = resolve;
  });
  let status = 201;
  const page = new EventEmitter();
  class Locator {
    _apiName = "Locator";
    async _expect() {
      return { matches: true };
    }
    async click() {}
    async focus() {}
    async evaluateAll() {
      return { focused: {}, elements: [] };
    }
  }
  const control = new Locator();
  const command = (type: string, failed: boolean) => {
    const request = {
      url: () => "http://localhost/api/document/command",
      method: () => "POST",
      postData: () => JSON.stringify({ type }),
    };
    page.emit("request", request);
    page.emit("response", {
      url: request.url,
      request: () => request,
      status: () => (failed ? status : 200),
      text: () => {
        if (!failed) return Promise.resolve('{"ok":true,"type":"Applied"}');
        bodyRequested();
        return body;
      },
    });
  };
  const active = Object.assign(page, {
    setViewportSize: async () => {},
    emulateMedia: async () => {},
    goto: async () => {},
    evaluate: async () => {},
    waitForLoadState: async () => {},
    locator: () => control,
    getByRole: () => control,
    screenshot: async (options: { path: string }) => {
      if (failedPhase === "action" && options.path.endsWith("/saved.png"))
        command("TrimClipEdge", true);
      return Buffer.from("literal screenshot");
    },
    keyboard: {
      press: async (value: string) => {
        if (value !== "ControlOrMeta+z") return;
        command("UndoHistory", failedPhase === "undo");
        simulation.state = task.start;
        simulation.persistState?.(task.start);
        simulation.history = {
          cursor: 0,
          headId: "baseline",
          entries: simulation.history!.entries,
        };
        if (failedPhase !== null) {
          await bodyReady;
          status = 503;
          rejectBody(new Error("literal native body unavailable"));
        }
      },
    },
  });
  return { active, task, root };
}
it("retains committed raw split identities after successful range-cut Save and Undo", async () => {
  const { active, task, root } = runner(null, "range-cut");
  const { readEditingState } = await vi.importActual<
    typeof import("./editingTaskEvidence")
  >("./editingTaskEvidence");
  simulation.readState = readEditingState;
  simulation.persistState = (state) => {
    fs.writeFileSync(
      simulation.fixture.projectPath,
      JSON.stringify({
        sources: state.sources,
        timeline: {
          duration_sec: state.duration_sec,
          clips: state.clips.map((clip) => ({
            ...clip,
            id:
              clip.id === "cut-left"
                ? "literal-generated-left"
                : clip.id === "cut-right"
                  ? "literal-generated-right"
                  : clip.id,
          })),
          tracks: state.tracks.map(({ invariants, ...track }) => ({
            ...track,
            ...(invariants as object),
          })),
        },
        editorial: {
          chapters: [],
          speaker_splits: [],
          retained_bleed_alignments: [],
        },
        mix: { automation_envelopes: [], processing_chains: [] },
        social: { clip_candidates: [] },
        review: { comments: [], versions: [], active_version_id: null },
      }),
    );
  };
  simulation.persistState(task.start);
  const output = path.join(root, "out");
  const trial = await runEditingTask(
    active as unknown as Page,
    {} as CDPSession,
    {
      outputPath: () => path.join(root, "profile.json"),
    } as unknown as TestInfo,
    task,
    "literal-runner",
    output,
    "validity-only",
  );
  expect(assessEditingTrial(task, trial)).toMatchObject({
    status: "pass",
    completedWork: 1,
    observations: { save: "pass", cancel: "not-applicable", undo: "pass" },
  });
  expect(trial.after?.clips.map((clip) => clip.id)).toEqual([
    "first-copy",
    "cut-left",
    "cut-right",
    "peer",
  ]);
  expect(
    readEditingState(path.join(output, "committed-project.json")).clips.map(
      (clip) => clip.id,
    ),
  ).toEqual([
    "first-copy",
    "literal-generated-left",
    "literal-generated-right",
    "peer",
  ]);
  expect({
    undone: trial.undone?.clips.map((clip) => clip.id),
    final: readEditingState(path.join(output, "saved-project.json")).clips.map(
      (clip) => clip.id,
    ),
  }).toEqual({
    undone: ["first-copy", "second-copy", "peer"],
    final: ["first-copy", "second-copy", "peer"],
  });
  expect(
    JSON.parse(
      fs.readFileSync(path.join(output, "clip-identities.json"), "utf8"),
    ),
  ).toEqual({
    "first-copy": "first-copy",
    "literal-generated-left": "cut-left",
    "literal-generated-right": "cut-right",
    peer: "peer",
  });
});
it("retains a command admitted during action after the runner advances into Undo", async () => {
  const { active, task, root } = runner("action");
  const trial = await runEditingTask(
    active as unknown as Page,
    {} as CDPSession,
    {
      outputPath: () => path.join(root, "profile.json"),
    } as unknown as TestInfo,
    task,
    "literal-runner",
    path.join(root, "out"),
    "validity-only",
  );
  expect(
    trial.journal.filter((row) => row.kind === "command-body-failed"),
  ).toEqual([
    {
      seq: 11,
      owner: "main",
      phase: "action",
      kind: "command-body-failed",
      requestId: 6,
      status: 201,
      error: "Error: literal native body unavailable",
      errorName: "Error",
    },
  ]);
  expect(trial.journal.find((row) => row.seq === 9)).toMatchObject({
    owner: "main",
    phase: "undo",
    kind: "request",
    type: "UndoHistory",
  });
  expect(assessEditingTrial(task, trial)).toMatchObject({
    status: "fail",
    completedWork: 0,
    mutations: 1,
    observations: { save: "fail", cancel: "not-applicable", undo: "fail" },
  });
});
it("fails an unavailable Undo command body while preserving completed Save proof", async () => {
  const { active, task, root } = runner("undo");
  const trial = await runEditingTask(
    active as unknown as Page,
    {} as CDPSession,
    {
      outputPath: () => path.join(root, "profile.json"),
    } as unknown as TestInfo,
    task,
    "literal-runner",
    path.join(root, "out"),
    "validity-only",
  );
  expect(
    trial.journal.filter((row) => row.kind === "command-body-failed"),
  ).toEqual([
    {
      seq: 9,
      owner: "main",
      phase: "undo",
      kind: "command-body-failed",
      requestId: 8,
      status: 201,
      error: "Error: literal native body unavailable",
      errorName: "Error",
    },
  ]);
  expect(assessEditingTrial(task, trial)).toMatchObject({
    status: "fail",
    completedWork: 0,
    mutations: 1,
    observations: { save: "pass", cancel: "not-applicable", undo: "fail" },
  });
}, 10000);

it.each([
  { failedSetup: "newPage", closeFails: false },
  { failedSetup: "newCDPSession", closeFails: false },
  { failedSetup: "newPage", closeFails: true },
  { failedSetup: "newCDPSession", closeFails: true },
] as const)(
  "closes a cancellation context after $failedSetup rejection with closeFails=$closeFails and continues main work",
  async ({ failedSetup, closeFails }) => {
    const { active, task, root } = runner(null);
    const route = task.routes[0];
    if ("pending" in route)
      throw new Error("literal runner route must be supported");
    route.cancellation = [{ id: "cancel", input: { kind: "route-cancel" } }];
    let closeCount = 0;
    const cancelPage = new EventEmitter();
    const context = {
      newPage: async () => {
        if (failedSetup === "newPage")
          throw new Error("literal cancellation page unavailable");
        return cancelPage;
      },
      newCDPSession: async () => {
        throw new Error("literal cancellation CDP unavailable");
      },
      close: async () => {
        closeCount++;
        if (closeFails)
          throw new Error("literal cancellation context close unavailable");
      },
    };
    Object.assign(cancelPage, { context: () => context });
    Object.assign(active, {
      context: () => ({ browser: () => ({ newContext: async () => context }) }),
    });
    const trial = await runEditingTask(
      active as unknown as Page,
      {} as CDPSession,
      {
        outputPath: () => path.join(root, "profile.json"),
      } as unknown as TestInfo,
      task,
      "literal-runner",
      path.join(root, "out"),
      "validity-only",
    );
    expect(closeCount).toBe(1);
    expect(trial.failures).toHaveLength(closeFails ? 2 : 1);
    expect(trial.failures).toEqual(
      expect.arrayContaining([
        {
          origin: { owner: "cancel", phase: "setup", probe: "cancel" },
          error: expect.stringContaining(
            failedSetup === "newPage"
              ? "literal cancellation page unavailable"
              : "literal cancellation CDP unavailable",
          ),
          errorName: "Error",
        },
        ...(closeFails
          ? [
              {
                origin: { owner: "cancel", phase: "cancel", probe: null },
                error:
                  "cancel context close: Error: literal cancellation context close unavailable",
                errorName: "Error",
              },
            ]
          : []),
      ]),
    );
    expect(trial.cancellations).toEqual([
      { probe: "cancel", outcome: "failed", state: task.start },
    ]);
    expect(trial.after).toEqual(task.expected);
    expect(trial.undone).toEqual(task.start);
    expect(assessEditingTrial(task, trial)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations: { save: "pass", cancel: "fail", undo: "pass" },
    });
  },
  10000,
);

it("retains null recovery for a later clone acquisition failure without borrowing the completed probe", async () => {
  const { active, task, root } = runner(null);
  const route = task.routes[0];
  if ("pending" in route)
    throw new Error("literal runner route must be supported");
  route.cancellation = [
    { id: "short", input: { kind: "route-cancel" } },
    { id: "vertical", input: { kind: "route-cancel" } },
  ];
  const priorClone = {
    projectPath: path.join(root, "short-clone.project.json"),
    workspaceDir: root,
  };
  const priorCloneBytes =
    '{"clone":"literal-short-clone","project":"literal-short-project","recipe":"short"}\n';
  fs.writeFileSync(priorClone.projectPath, priorCloneBytes);
  simulation.states.set(priorClone.projectPath, task.start);
  simulation.fixtureSequence = [
    simulation.fixture,
    priorClone,
    new Error("literal vertical clone preparation unavailable"),
  ];
  const cancelPage = new EventEmitter();
  let closeCount = 0;
  const context = {
    newPage: async () => cancelPage,
    newCDPSession: async () => ({}),
    close: async () => {
      closeCount++;
    },
  };
  Object.assign(cancelPage, {
    context: () => context,
    setViewportSize: active.setViewportSize,
    emulateMedia: active.emulateMedia,
    goto: active.goto,
    evaluate: active.evaluate,
    waitForLoadState: active.waitForLoadState,
    locator: active.locator,
    getByRole: active.getByRole,
    screenshot: active.screenshot,
    keyboard: active.keyboard,
  });
  Object.assign(active, {
    context: () => ({ browser: () => ({ newContext: async () => context }) }),
  });
  const output = path.join(root, "out");
  const trial = await runEditingTask(
    active as unknown as Page,
    {} as CDPSession,
    {
      outputPath: () => path.join(root, "profile.json"),
    } as unknown as TestInfo,
    task,
    "literal-runner",
    output,
    "validity-only",
  );
  expect(trial.failures).toEqual([
    {
      origin: { owner: "cancel", phase: "setup", probe: "vertical" },
      error: "cancel: Error: literal vertical clone preparation unavailable",
      errorName: "Error",
    },
  ]);
  expect(trial.cancellations).toEqual([
    { probe: "short", outcome: "completed", state: task.start },
    { probe: "vertical", outcome: "failed", state: null },
  ]);
  expect({
    priorClone: fs.readFileSync(priorClone.projectPath, "utf8"),
    initialReceipt: fs.readFileSync(
      path.join(output, "canceled-short-initial-project.json"),
      "utf8",
    ),
    completedReceipt: fs.readFileSync(
      path.join(output, "canceled-short-project.json"),
      "utf8",
    ),
    failedRecoveryExists: fs.existsSync(
      path.join(output, "failed-cancel-project.json"),
    ),
    verticalInitialExists: fs.existsSync(
      path.join(output, "canceled-vertical-initial-project.json"),
    ),
  }).toEqual({
    priorClone:
      '{"clone":"literal-short-clone","project":"literal-short-project","recipe":"short"}\n',
    initialReceipt:
      '{"clone":"literal-short-clone","project":"literal-short-project","recipe":"short"}\n',
    completedReceipt:
      '{"clone":"literal-short-clone","project":"literal-short-project","recipe":"short"}\n',
    failedRecoveryExists: false,
    verticalInitialExists: false,
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(output, "trial.json"), "utf8")),
  ).toMatchObject({
    cancellations: [
      { probe: "short", outcome: "completed", state: task.start },
      { probe: "vertical", outcome: "failed", state: null },
    ],
  });
  expect(trial.after).toEqual(task.expected);
  expect(trial.undone).toEqual(task.start);
  expect(closeCount).toBe(1);
  expect(assessEditingTrial(task, trial)).toMatchObject({
    status: "fail",
    completedWork: 0,
    mutations: 1,
    accidentalCommands: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
}, 10000);

it.each([false, true])(
  "retains the failed named cancellation when recovery copy fails with stateFailure=%s",
  async (stateFailure) => {
    const { active, task, root } = runner(null);
    const route = task.routes[0];
    if ("pending" in route)
      throw new Error("literal runner route must be supported");
    route.cancellation = [
      { id: "copy-failure", input: { kind: "route-cancel" } },
    ];
    const clone = {
      projectPath: path.join(root, "failed-clone.project.json"),
      workspaceDir: root,
    };
    fs.writeFileSync(clone.projectPath, '{"clone":"literal-failed-clone"}\n');
    simulation.states.set(clone.projectPath, task.start);
    simulation.fixtureSequence = [simulation.fixture, clone];
    if (stateFailure)
      simulation.readState = (projectPath) => {
        if (projectPath === clone.projectPath)
          throw new Error("literal cancel recovery state unavailable");
        return simulation.state!;
      };
    const cancelPage = new EventEmitter();
    const context = {
      newPage: async () => cancelPage,
      newCDPSession: async () => ({}),
      close: async () => {},
    };
    Object.assign(cancelPage, {
      context: () => context,
      setViewportSize: async () => {
        throw new Error("literal cancellation preparation unavailable");
      },
      waitForLoadState: active.waitForLoadState,
      locator: active.locator,
      screenshot: active.screenshot,
    });
    Object.assign(active, {
      context: () => ({ browser: () => ({ newContext: async () => context }) }),
    });
    const output = path.join(root, "out");
    const copyFile = fs.copyFileSync;
    const copyFault = vi
      .spyOn(fs, "copyFileSync")
      .mockImplementation((source, target, flags) => {
        if (String(target) === path.join(output, "failed-cancel-project.json"))
          throw new Error("literal failed clone copy unavailable");
        return copyFile(source, target, flags);
      });
    let produced: Awaited<ReturnType<typeof runEditingTask>>;
    try {
      produced = await runEditingTask(
        active as unknown as Page,
        {} as CDPSession,
        {
          outputPath: () => path.join(root, "profile.json"),
        } as unknown as TestInfo,
        task,
        "literal-runner",
        output,
        "validity-only",
      );
    } finally {
      copyFault.mockRestore();
    }
    const retained = JSON.parse(
      fs.readFileSync(path.join(output, "trial.json"), "utf8"),
    );
    const assessment = assessEditingTrial(task, produced);
    if (process.env.POTETO_CANCELLATION_OUT) {
      fs.mkdirSync(process.env.POTETO_CANCELLATION_OUT, { recursive: true });
      const evidence = fs.mkdtempSync(
        path.join(
          process.env.POTETO_CANCELLATION_OUT,
          stateFailure ? "copy-and-state-failure-" : "copy-failure-",
        ),
      );
      fs.cpSync(root, evidence, { recursive: true });
      fs.writeFileSync(
        path.join(evidence, "returned-trial.json"),
        JSON.stringify(produced, null, 2),
      );
      fs.writeFileSync(
        path.join(evidence, "returned-assessment.json"),
        JSON.stringify(assessment, null, 2),
      );
    }
    expect({
      returnedFailures: produced.failures.map((failure) => ({
        message: failure.error.split("Error: ").at(-1),
        errorName: failure.errorName,
      })),
      returnedCancellations: produced.cancellations.map((row) => ({
        probe: row.probe,
        outcome: row.outcome,
        state: row.state === null ? "unavailable" : "retained",
      })),
      retainedCancellations: retained.cancellations.map(
        (row: { probe: string; outcome: string; state: unknown }) => ({
          probe: row.probe,
          outcome: row.outcome,
          state: row.state === null ? "unavailable" : "retained",
        }),
      ),
      retainedFailureMessages: retained.failures.map(
        (failure: { error: string }) => failure.error.split("Error: ").at(-1),
      ),
      semantic: assessment,
    }).toMatchObject({
      returnedFailures: [
        {
          message: "literal cancellation preparation unavailable",
          errorName: "Error",
        },
        ...(stateFailure
          ? [
              {
                message: "literal cancel recovery state unavailable",
                errorName: "Error",
              },
            ]
          : []),
        {
          message: "literal failed clone copy unavailable",
          errorName: "Error",
        },
      ],
      returnedCancellations: [
        {
          probe: "copy-failure",
          outcome: "failed",
          state: stateFailure ? "unavailable" : "retained",
        },
      ],
      retainedCancellations: [
        {
          probe: "copy-failure",
          outcome: "failed",
          state: stateFailure ? "unavailable" : "retained",
        },
      ],
      retainedFailureMessages: [
        "literal cancellation preparation unavailable",
        ...(stateFailure ? ["literal cancel recovery state unavailable"] : []),
        "literal failed clone copy unavailable",
      ],
      semantic: {
        status: "fail",
        completedWork: 0,
        observations: { save: "pass", cancel: "fail", undo: "pass" },
      },
    });
    expect(produced.after).toEqual(task.expected);
    expect(produced.undone).toEqual(task.start);
    expect(fs.readFileSync(clone.projectPath, "utf8")).toBe(
      '{"clone":"literal-failed-clone"}\n',
    );
  },
  10000,
);

function cancellationFixture() {
  const { active, task, root } = runner(null);
  const route = task.routes[0];
  if ("pending" in route)
    throw new Error("Literal runner route must be supported");
  route.cancellation = [{ id: "retention", input: { kind: "route-cancel" } }];
  const clone = {
    projectPath: path.join(root, "retention-clone.project.json"),
    workspaceDir: root,
  };
  fs.writeFileSync(clone.projectPath, '{"clone":"literal-retention-clone"}\n');
  simulation.states.set(clone.projectPath, task.start);
  simulation.fixtureSequence = [simulation.fixture, clone];
  const cancelPage = new EventEmitter();
  const context = {
    newPage: async () => cancelPage,
    newCDPSession: async () => ({}),
    close: async () => {},
  };
  Object.assign(cancelPage, {
    context: () => context,
    setViewportSize: active.setViewportSize,
    emulateMedia: active.emulateMedia,
    goto: active.goto,
    evaluate: active.evaluate,
    waitForLoadState: active.waitForLoadState,
    locator: active.locator,
    getByRole: active.getByRole,
    screenshot: active.screenshot,
    keyboard: active.keyboard,
  });
  Object.assign(active, {
    context: () => ({ browser: () => ({ newContext: async () => context }) }),
  });
  const output = path.join(root, "out");
  const run = () =>
    runEditingTask(
      active as unknown as Page,
      {} as CDPSession,
      {
        outputPath: () => path.join(root, "profile.json"),
      } as unknown as TestInfo,
      task,
      "literal-runner",
      output,
      "validity-only",
    );
  return { active, task, clone, cancelPage, output, run };
}
it("retains the completed named result before a later clone artifact copy fails", async () => {
  const { task, output, run } = cancellationFixture();
  const copy = fs.copyFileSync;
  const copying = vi
    .spyOn(fs, "copyFileSync")
    .mockImplementation((source, target, flags) => {
      if (
        String(target) === path.join(output, "canceled-retention-project.json")
      ) {
        expect(
          JSON.parse(fs.readFileSync(path.join(output, "trial.json"), "utf8"))
            .cancellations,
        ).toEqual([
          { probe: "retention", outcome: "completed", state: task.start },
        ]);
        throw new Error("literal completed clone artifact unavailable");
      }
      return copy(source, target, flags);
    });
  let produced: Awaited<ReturnType<typeof runEditingTask>>;
  try {
    produced = await run();
  } finally {
    copying.mockRestore();
  }
  expect(produced.cancellations).toEqual([
    { probe: "retention", outcome: "completed", state: task.start },
  ]);
  expect(produced.failures).toEqual([
    {
      origin: { owner: "cancel", phase: "cancel", probe: "retention" },
      error: "cancel: Error: literal completed clone artifact unavailable",
      errorName: "Error",
    },
  ]);
  expect(assessEditingTrial(task, produced)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
  expect(
    produced.journal.filter(
      (row) => row.kind === "activation" && row.phase === "cancel",
    ),
  ).toEqual([
    expect.objectContaining({
      owner: "cancel",
      probe: "retention",
      outcome: "completed",
    }),
  ]);
  expect(
    produced.journal.filter(
      (row) => row.kind === "activation" && row.phase === "action",
    ),
  ).toEqual([expect.objectContaining({ owner: "main", outcome: "completed" })]);
});
it("keeps optional failed-clone UI errors under the named probe", async () => {
  const { task, cancelPage, run } = cancellationFixture();
  Object.assign(cancelPage, {
    setViewportSize: async () => {
      throw new Error("literal clone preparation unavailable");
    },
    locator: () => ({
      evaluateAll: async () => {
        throw new Error("literal failed clone UI unavailable");
      },
    }),
  });
  const produced = await run();
  expect(produced.cancellations).toEqual([
    { probe: "retention", outcome: "failed", state: task.start },
  ]);
  expect(produced.failures).toEqual([
    {
      origin: { owner: "cancel", phase: "setup", probe: "retention" },
      error: "cancel: Error: literal clone preparation unavailable",
      errorName: "Error",
    },
    {
      origin: { owner: "cancel", phase: "setup", probe: "retention" },
      error: "cancel recovery UI: Error: literal failed clone UI unavailable",
      errorName: "Error",
    },
  ]);
  expect(assessEditingTrial(task, produced)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
it("keeps a failed shared trial write global during named cancellation retention", async () => {
  const { task, cancelPage, output, run } = cancellationFixture();
  Object.assign(cancelPage, {
    setViewportSize: async () => {
      throw new Error("literal clone preparation unavailable");
    },
  });
  let failedWrite = false;
  const write = fs.writeFileSync;
  const writing = vi
    .spyOn(fs, "writeFileSync")
    .mockImplementation((target, data, options) => {
      if (
        !failedWrite &&
        String(target) === path.join(output, "trial.json") &&
        typeof data === "string" &&
        data.includes('"outcome": "failed"')
      ) {
        failedWrite = true;
        throw new Error("literal shared trial retention unavailable");
      }
      return write(target, data, options);
    });
  let produced: Awaited<ReturnType<typeof runEditingTask>>;
  try {
    produced = await run();
  } finally {
    writing.mockRestore();
  }
  expect(failedWrite).toBe(true);
  expect(produced.cancellations).toEqual([
    { probe: "retention", outcome: "failed", state: null },
  ]);
  expect(produced.failures).toEqual([
    {
      origin: { owner: "cancel", phase: "setup", probe: "retention" },
      error: "cancel: Error: literal clone preparation unavailable",
      errorName: "Error",
    },
    {
      origin: { owner: "global", blocks: "all-proofs" },
      error:
        "trial retention: Error: literal shared trial retention unavailable",
      errorName: "Error",
    },
  ]);
  expect(produced.after).toEqual(task.expected);
  expect(produced.undone).toEqual(task.start);
  expect(assessEditingTrial(task, produced)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "fail", undo: "fail" },
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(output, "trial.json"), "utf8")),
  ).toMatchObject({
    failures: produced.failures,
    cancellations: produced.cancellations,
  });
});
it("records an unregistered input UI page as a shared attribution failure", async () => {
  const { active, task, root } = runner(null);
  simulation.captureWrongPage = true;
  const produced = await runEditingTask(
    active as unknown as Page,
    {} as CDPSession,
    {
      outputPath: () => path.join(root, "profile.json"),
    } as unknown as TestInfo,
    task,
    "literal-runner",
    path.join(root, "out"),
    "validity-only",
  );
  expect(produced.failures).toEqual([
    {
      origin: { owner: "global", blocks: "all-proofs" },
      error: "Error: Editing evidence page has no registered origin",
      errorName: "Error",
    },
  ]);
  expect(assessEditingTrial(task, produced)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "not-applicable", undo: "fail" },
  });
});
