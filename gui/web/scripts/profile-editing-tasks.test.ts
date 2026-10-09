import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { editingTaskRegistry } from "../e2e/editingTaskCases";
import {
  assessEditingTrial,
  type EditingTrial,
} from "../e2e/editingTaskReport";
import {
  control,
  invoke,
  readJson,
  restoreInvocation,
  type Summary,
} from "./profile-editing-tasks.fixture";

afterEach(restoreInvocation);

const passingSemantics = {
  status: "pass",
  completedWork: 1,
  mutations: 1,
  accidentalCommands: 0,
  observations: { save: "pass", cancel: "pass", undo: "pass" },
};

it("admits five complete canonical profiles with matching served bytes and real assessed semantics", async () => {
  const { rejection, summary, selected, backendCalls } =
    await invoke("complete");
  expect(backendCalls).toHaveLength(1);
  expect(readJson(path.join(control.out, "backend-import.log"))).toEqual({
    cwd: control.repo,
    executable: "controlled-backend-import-boundary",
    module: path.join(control.repo, "src/podcast_mcp/gui/server.py"),
  });
  expect(readJson(path.join(control.out, "protocol.json"))).toMatchObject({
    backend: { executable: "controlled-backend-import-boundary" },
  });
  expect({
    rejection,
    exitCode: process.exitCode,
    complete: summary?.selectedProofComplete,
  }).toEqual({
    rejection: null,
    exitCode: 0,
    complete: true,
  });
  expect(selected).toMatchObject({
    status: "pass",
    attempted: 5,
    valid: 5,
    failed: 0,
    baselineValid: 5,
    duration: { medianMs: 10, minMs: 10, maxMs: 10 },
  });
  expect(summary?.attempts).toHaveLength(5);
  for (const attempt of control.launched) {
    expect(
      assessEditingTrial(
        editingTaskRegistry.find((row) => row.id === "trim")!,
        readJson<EditingTrial>(path.join(attempt, "trial.json"))!,
      ),
    ).toMatchObject(passingSemantics);
    expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
      schemaVersion: 1,
      measurementVersion: "editor-response-v1",
      status: "complete",
      errors: [],
      environment: {
        build: {
          status: "measured",
          value: { mode: "production", e2eHooks: false },
        },
      },
      samples: [{ result: { status: "completed" } }],
    });
  }
  for (const row of summary!.attempts) {
    expect(row.semantic).toMatchObject({
      kind: "assessed",
      result: passingSemantics,
      observedDurationMs: 10,
    });
    expect(row.runner).toEqual({ kind: "returned", code: 0 });
  }
}, 120000);

it.each([
  {
    kind: "metadata" as const,
    error: "metadata: Error: literal profiler page metadata unavailable",
  },
  {
    kind: "attachment" as const,
    error:
      "attachment retention: Error: literal profiler attachment unavailable",
  },
])(
  "excludes canonical $kind failure while retaining passing semantic observations",
  async ({ kind, error }) => {
    const { rejection, summary, selected } = await invoke(kind);
    for (const attempt of control.launched) {
      expect(
        readJson(path.join(attempt, "profiler/report.json")),
      ).toMatchObject({
        status: "incomplete",
        errors: [error],
        environment: { build: { status: "measured" } },
        samples: [{ result: { status: "completed" } }],
      });
    }
    expect({
      rejection,
      exitCode: process.exitCode,
      complete: summary?.selectedProofComplete,
    }).toEqual({
      rejection: null,
      exitCode: 1,
      complete: false,
    });
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    for (const row of summary!.attempts)
      expect(row.semantic).toMatchObject({
        kind: "assessed",
        result: passingSemantics,
      });
  },
  120000,
);

it.each([
  "missing-status",
  "malformed-status",
  "missing-errors",
  "malformed-errors",
  "nonempty-errors",
  "missing-schema",
  "malformed-schema",
  "future-schema",
  "missing-measurement",
  "unknown-measurement",
  "missing-build",
  "mismatched-asset",
] as const)(
  "rejects %s profiler receipt through actual CLI admission",
  async (kind) => {
    const { rejection, summary, selected } = await invoke(kind);
    expect({
      rejection,
      exitCode: process.exitCode,
      complete: summary?.selectedProofComplete,
    }).toEqual({
      rejection: null,
      exitCode: 1,
      complete: false,
    });
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    for (const row of summary!.attempts)
      expect(row.semantic).toMatchObject({
        kind: "assessed",
        result: passingSemantics,
      });
  },
  120000,
);

it.each(["nonfinite-duration", "failed-semantics"] as const)(
  "excludes %s even with a complete canonical profile",
  async (kind) => {
    const { summary, selected } = await invoke(kind);
    expect(process.exitCode).toBe(1);
    expect(summary?.selectedProofComplete).toBe(false);
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
    expect(summary?.attempts).toHaveLength(5);
    if (kind === "nonfinite-duration") {
      for (const row of summary!.attempts) {
        expect(row.semantic?.result).toMatchObject({
          status: "fail",
          observations: passingSemantics.observations,
          reasons: expect.arrayContaining([
            "elapsed duration is missing, non-finite or negative",
          ]),
        });
      }
    } else {
      for (const row of summary!.attempts) {
        expect(row.semantic?.result).toMatchObject({
          status: "fail",
          completedWork: 0,
          observations: { save: "fail", cancel: "pass", undo: "fail" },
          reasons: expect.arrayContaining(["literal saved-action failure"]),
        });
      }
    }
    for (const attempt of control.launched)
      expect(
        readJson(path.join(attempt, "profiler/report.json")),
      ).toMatchObject({ status: "complete", errors: [] });
  },
  120000,
);

it("preserves the five-trial baseline threshold at the actual CLI parser", async () => {
  const { rejection, backendCalls } = await invoke("complete", { trials: 4 });
  expect(backendCalls).toEqual([]);
  expect(rejection).toBe(
    "Error: Use --app-base SHA --trials N --out NEW_DIRECTORY; baseline requires at least five trials",
  );
  expect(control.launched).toEqual([]);
});

it.each(["mismatched-task", "mismatched-route"] as const)(
  "rejects %s at the scheduled receipt boundary despite readable passing semantics",
  async (kind) => {
    const { summary, selected } = await invoke(kind);
    const task = editingTaskRegistry.find((row) => row.id === "trim")!;
    for (const attempt of control.launched) {
      const raw = readJson<EditingTrial>(path.join(attempt, "trial.json"))!;
      expect({ task: raw.task, route: raw.route }).toEqual(
        kind === "mismatched-task"
          ? { task: "range-cut", route: "handle-keyboard" }
          : { task: "trim", route: "handle-pointer" },
      );
      expect(assessEditingTrial(task, raw)).toMatchObject(passingSemantics);
    }
    expect(control.launched).toHaveLength(5);
    expect(process.exitCode).toBe(1);
    expect(summary?.selectedProofComplete).toBe(false);
    expect(selected).toMatchObject({
      status: "fail",
      attempted: 5,
      valid: 0,
      failed: 5,
      baselineValid: 0,
      duration: null,
    });
  },
  120000,
);

it("excludes a settled nonzero runner exit while retaining passing semantics and a complete profile", async () => {
  const { summary, selected } = await invoke("nonzero-runner");
  expect(process.exitCode).toBe(1);
  expect(summary?.selectedProofComplete).toBe(false);
  expect(selected).toMatchObject({
    status: "fail",
    attempted: 5,
    valid: 0,
    failed: 5,
    baselineValid: 0,
    duration: null,
  });
  expect(summary?.attempts).toHaveLength(5);
  for (const row of summary!.attempts) {
    expect(row.runner).toEqual({ kind: "returned", code: 23 });
    expect(row.semantic).toMatchObject({
      kind: "assessed",
      result: passingSemantics,
    });
  }
  for (const attempt of control.launched)
    expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
      status: "complete",
      errors: [],
    });
}, 120000);

function expectCleanupEvidence() {
  expect(control.rejectedLifecycle).toBe(
    "Error: literal cleanup workspace remained busy",
  );
  expect(control.removalAttempts).toBe(5);
  expect(
    fs.readFileSync(path.join(control.cleanupWorkspace, "marker.json"), "utf8"),
  ).toBe('{"producedTrial":true}\n');
  expect(readJson(control.cleanupManifest)).toEqual({
    workspaces: [control.cleanupWorkspace],
  });
  const attempt = control.launched.at(-1)!;
  const retained = readJson<EditingTrial>(path.join(attempt, "trial.json"))!;
  const task = editingTaskRegistry.find((row) => row.id === "trim")!;
  expect(assessEditingTrial(task, retained)).toMatchObject(passingSemantics);
  expect(readJson(path.join(attempt, "profiler/report.json"))).toMatchObject({
    status: "complete",
    errors: [],
  });
}

function expectStoppedCensus(summary: Summary | null, cleanupAt: number) {
  expect(summary?.selectedProofComplete).toBe(false);
  const route = summary?.routes.find(
    (row) => row.task === "trim" && row.route === "handle-keyboard",
  );
  expect(route).toMatchObject({
    status: "fail",
    attempted: cleanupAt,
    failed: 1,
    notRun: 5 - cleanupAt,
    valid: cleanupAt - 1,
    baselineValid: cleanupAt - 1,
    duration: null,
  });
  expect(
    summary?.attempts.map((row) => ({
      task: row.task,
      route: row.route,
      trial: row.trial,
    })),
  ).toEqual(
    [1, 2, 3, 4, 5].map((trial) => ({
      task: "trim",
      route: "handle-keyboard",
      trial,
    })),
  );
  const failed = summary!.attempts[cleanupAt - 1]!;
  expect(failed.runner).toEqual({
    kind: "rejected",
    error: "Error: literal cleanup workspace remained busy",
  });
  expect(failed).not.toHaveProperty("code");
  expect(JSON.stringify(failed)).toContain(
    "literal cleanup workspace remained busy",
  );
  expect(failed.semantic).toMatchObject({
    kind: "assessed",
    result: passingSemantics,
  });
  for (const row of summary!.attempts.slice(cleanupAt)) {
    expect(row).not.toHaveProperty("runner");
    expect(row).not.toHaveProperty("code");
    expect(JSON.stringify(row)).toMatch(/stop|cleanup|lifecycle/i);
  }
  for (const trial of [1, 2, 3, 4, 5]) {
    expect(
      readJson(
        path.join(control.out, `trim-handle-keyboard-${trial}`, "status.json"),
      ),
    ).toMatchObject({
      task: "trim",
      route: "handle-keyboard",
      trial,
      status:
        trial < cleanupAt ? "pass" : trial === cleanupAt ? "fail" : "not-run",
    });
  }
}

it.each([1, 3])(
  "retains the whole five-slot schedule when real cleanup rejects on attempt %s",
  async (cleanupAt) => {
    const { summary, attempts } = await invoke("complete", { cleanupAt });
    expectCleanupEvidence();
    expect(process.exitCode).toBe(1);
    expect(control.launched).toHaveLength(cleanupAt);
    expectStoppedCensus(summary, cleanupAt);
    expect(attempts).toEqual(summary!.attempts);
  },
  120000,
);

it("still writes the final summary and truthful statuses when final ledger retention also fails", async () => {
  const { rejection, summary, attempts } = await invoke("complete", {
    cleanupAt: 1,
    failLedgerWrite: true,
  });
  expectCleanupEvidence();
  expect(process.exitCode).toBe(1);
  expect(control.launched).toHaveLength(1);
  expectStoppedCensus(summary, 1);
  expect(
    attempts?.map((row) => ({
      task: row.task,
      route: row.route,
      trial: row.trial,
      kind: row.kind,
    })),
  ).toEqual(
    [1, 2, 3, 4, 5].map((trial) => ({
      task: "trim",
      route: "handle-keyboard",
      trial,
      kind: "not-run",
    })),
  );
  for (const row of attempts!) {
    expect(row).not.toHaveProperty("runner");
    expect(row).not.toHaveProperty("semantic");
  }
  expect(JSON.stringify({ rejection, summary })).toContain(
    "literal final attempt ledger unavailable",
  );
}, 120000);
