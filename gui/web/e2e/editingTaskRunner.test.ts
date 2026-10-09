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
  state: undefined as DurableState | undefined,
  history: undefined as HistoryIdentity | undefined,
}));
vi.mock("./editingTaskEvidence", () => ({
  createEditingFixture: () => simulation.fixture,
  readEditingState: () => simulation.state,
  readEditingHistory: () => simulation.history,
  verifyEditingBackend: () => {},
}));
vi.mock("./shareableProject", () => ({ switchE2eProject: async () => {} }));
vi.mock("./editingTaskInputs", () => ({
  navigateEditingTimeline: async () => {},
  performEditingInput: async (
    context: { active: EventEmitter; task: TaskDefinition },
    recorder: {
      act(
        verb: string,
        label: string,
        action: () => Promise<void>,
      ): Promise<void>;
    },
  ) =>
    recorder.act("key", "literal saved edit", async () => {
      const request = {
        url: () => "http://localhost/api/document/command",
        method: () => "POST",
        postData: () => '{"type":"TrimClipEdge"}',
      };
      context.active.emit("request", request);
      context.active.emit("response", {
        url: request.url,
        request: () => request,
        status: () => 200,
        text: async () => '{"ok":true,"type":"Applied"}',
      });
      simulation.state = context.task.expected;
      simulation.history = {
        cursor: 1,
        headId: "changed",
        entries: [
          { id: "baseline", label: "before trim clip edge", operation: null },
          {
            id: "changed",
            label: "after trim clip edge",
            operation: "trim_clip_edge",
          },
        ],
      };
    }),
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function runner(failedPhase: "action" | "undo" | null) {
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
  const registered = editingTaskRegistry.find((row) => row.id === "trim")!;
  const task: TaskDefinition = {
    ...registered,
    routes: [
      {
        id: "literal-runner",
        input: "keyboard",
        command: "TrimClipEdge",
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
      text: () =>
        failed ? body : Promise.resolve('{"ok":true,"type":"Applied"}'),
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
        simulation.history = {
          cursor: 0,
          headId: "baseline",
          entries: simulation.history!.entries,
        };
        if (failedPhase !== null) {
          // Yield through the response adapter so its status precedes the native rejection.
          await Promise.resolve();
          await Promise.resolve();
          status = 503;
          rejectBody(new Error("literal native body unavailable"));
        }
      },
    },
  });
  return { active, task, root };
}
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
