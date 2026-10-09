import { expect, it } from "vitest";
import { assessEditingTrial, type TaskDefinition } from "./editingTaskReport";
import { definition, start, trial } from "./editingTaskTestFixtures";

function threeProbeTrial() {
  const t = trial();
  t.cancellations = ["short", "vertical", "touch-cancel"].map((probe) => ({
    probe,
    outcome: "completed",
    state: start,
  }));
  t.journal = t.journal.filter((row) => row.owner !== "cancel");
  t.journal.push(
    ...["short", "vertical", "touch-cancel"].map((probe, index) => ({
      seq: 8 + index,
      owner: "cancel" as const,
      phase: "cancel" as const,
      probe,
      kind: "activation" as const,
      label: "literal independent clone",
      verb: "touch",
      outcome: "completed" as const,
    })),
  );
  const task: TaskDefinition = {
    ...definition,
    routes: [
      {
        id: "keyboard",
        input: "keyboard",
        command: "TrimClipEdge",
        mutations: 1,
        undo: "history",
        cancellation: [
          {
            id: "short",
            input: { kind: "comment-swipe", dx: 20, dy: 0, end: "touchEnd" },
          },
          {
            id: "vertical",
            input: { kind: "comment-swipe", dx: 64, dy: 30, end: "touchEnd" },
          },
          {
            id: "touch-cancel",
            input: { kind: "comment-swipe", dx: 64, dy: 0, end: "touchCancel" },
          },
        ],
      },
    ],
  };
  return { t, task };
}
it("accepts completed saved work and derives deliberate input", () => {
  expect(assessEditingTrial(definition, trial())).toEqual({
    status: "pass",
    reasons: [],
    activations: { setup: 0, action: 1, cancel: 1, undo: 1 },
    mutations: 1,
    accidentalCommands: 0,
    completedWork: 1,
    canceledReads: 0,
    observations: { save: "pass", cancel: "pass", undo: "pass" },
  });
});
it("rejects an earlier failed cancellation even when the last clone is restored", () => {
  expect(
    assessEditingTrial(definition, {
      ...trial(),
      cancellations: [
        { probe: "cancel", outcome: "completed", state: definition.expected },
        { probe: "cancel", outcome: "completed", state: start },
      ],
    }).reasons,
  ).toEqual([
    "cancellation cancel has 2 results",
    "canceled-cancel.clips.a.source_start expected 0, observed 0.3",
    "canceled-cancel.clips.a.timeline_start expected 0, observed 0.3",
  ]);
});
it("requires recovery snapshots", () => {
  expect(
    assessEditingTrial(definition, {
      ...trial(),
      cancellations: [],
      undone: undefined,
    }).reasons,
  ).toEqual(["cancellation cancel has 0 results", "Undo not run"]);
});
it("rejects fabricated recovery snapshots without browser input", () => {
  const t = trial();
  t.journal = t.journal.filter((event) => event.phase === "action");
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "cancel input not observed",
    "cancellation cancel input not observed",
    "Undo input not observed",
    "Undo expected 1 UndoHistory commands, observed 0",
  ]);
});
it.each(["cancel", "undo"] as const)(
  "fails a failed %s activation without relabeling Save",
  (phase) => {
    const t = trial();
    const event = t.journal.find(
      (row) => row.kind === "activation" && row.phase === phase,
    )!;
    Object.assign(event, {
      outcome: "failed",
      error: "literal native input failure",
    });
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations:
        phase === "cancel"
          ? { save: "pass", cancel: "fail", undo: "pass" }
          : { save: "pass", cancel: "pass", undo: "fail" },
    });
  },
);
it.each(["http", "history"])(
  "fails Undo %s evidence without relabeling Save",
  (fault) => {
    const t = trial();
    if (fault === "http") Object.assign(t.journal[6], { status: 500 });
    else Object.assign(t.history!.undone!, { cursor: 1, headId: "changed" });
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations: { save: "pass", cancel: "pass", undo: "fail" },
    });
  },
);
it.each(["missing", "duplicate"])(
  "rejects %s named cancellation coverage",
  (fault) => {
    const t = trial();
    t.cancellations =
      fault === "missing"
        ? []
        : [
            { probe: "cancel", outcome: "completed", state: start },
            { probe: "cancel", outcome: "completed", state: start },
          ];
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations: { save: "pass", cancel: "fail", undo: "pass" },
    });
  },
);
it("admits all three independently completed named clones", () => {
  const { t, task } = threeProbeTrial();
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "pass",
    completedWork: 1,
    observations: { save: "pass", cancel: "pass", undo: "pass" },
  });
});
it.each([
  "empty",
  "missing",
  "duplicate",
  "unexpected",
  "unactivated",
  "started",
  "failed-result",
  "clone-setup",
])("rejects incomplete independent clones with %s evidence", (fault) => {
  const { t, task } = threeProbeTrial();
  if (fault === "empty") t.cancellations = [];
  if (fault === "missing") t.cancellations.pop();
  if (fault === "duplicate") t.cancellations[2] = t.cancellations[0];
  if (fault === "unexpected") t.cancellations[2].probe = "invented";
  if (fault === "unactivated")
    t.journal = t.journal.filter(
      (row) => row.owner !== "cancel" || row.probe !== "vertical",
    );
  if (fault === "started") Object.assign(t.journal[7], { outcome: "started" });
  if (fault === "failed-result")
    t.cancellations[0] = { probe: "short", outcome: "failed", state: start };
  if (fault === "clone-setup")
    t.failures.push({
      origin: { owner: "cancel", phase: "setup", probe: "short" },
      error: "literal clone setup failure",
      errorName: "Error",
    });
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
it("rejects earlier changed clone state despite a later restored clone", () => {
  const { t, task } = threeProbeTrial();
  t.cancellations[0].state = definition.expected;
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
it.each([
  "duration",
  "profiler",
  "trust",
  "main-setup",
  "save",
  "cancel-ui",
  "undo-ui",
])("projects %s failure through explicit prerequisites", (fault) => {
  const t = trial();
  if (fault === "duration") t.durationMs = NaN;
  if (fault === "profiler")
    t.failures.push({
      origin: { owner: "global", blocks: "admission" },
      error: "literal profiler failure",
      errorName: null,
    });
  if (fault === "trust")
    t.failures.push({
      origin: { owner: "global", blocks: "all-proofs" },
      error: "literal retention failure",
      errorName: null,
    });
  if (fault === "main-setup")
    t.failures.push({
      origin: { owner: "main", phase: "setup" },
      error: "literal setup failure",
      errorName: null,
    });
  if (fault === "save") t.after = start;
  if (fault === "cancel-ui")
    t.failures.push({
      origin: { owner: "cancel", phase: "cancel", probe: "cancel" },
      error: "literal UI value expected0 observed5",
      errorName: "Error",
    });
  if (fault === "undo-ui")
    t.failures.push({
      origin: { owner: "main", phase: "undo" },
      error: "literal UI failure",
      errorName: "Error",
    });
  const expected =
    fault === "trust"
      ? { save: "fail", cancel: "fail", undo: "fail" }
      : fault === "main-setup" || fault === "save"
        ? { save: "fail", cancel: "pass", undo: "fail" }
        : fault === "cancel-ui"
          ? { save: "pass", cancel: "fail", undo: "pass" }
          : fault === "undo-ui"
            ? { save: "pass", cancel: "pass", undo: "fail" }
            : { save: "pass", cancel: "pass", undo: "pass" };
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: expected,
  });
});
it.each([
  "missing-failures",
  "missing-results",
  "bad-global-owner",
  "bad-declaration",
])("rejects malformed current retained ownership %s", (fault) => {
  const t = trial(),
    task = structuredClone(definition);
  if (fault === "missing-failures") Object.assign(t, { failures: undefined });
  if (fault === "missing-results")
    Object.assign(t, { cancellations: undefined });
  if (fault === "bad-global-owner")
    t.failures.push({
      origin: {
        owner: "global",
        blocks: "admission",
        phase: "cancel",
      } as never,
      error: "cannot escape trust",
      errorName: null,
    });
  if (fault === "bad-declaration")
    Object.assign(task.routes[0], {
      cancellation: [
        { id: "cancel", input: { kind: "route-cancel" } },
        { id: "cancel", input: { kind: "route-cancel" } },
      ],
    });
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "fail", undo: "fail" },
  });
});
it("keeps missing unattempted proof distinct from an attempted missing snapshot", () => {
  const t = trial();
  t.cancellations = [];
  t.undone = undefined;
  t.journal = t.journal.filter((row) => row.phase === "action");
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "not-run", undo: "not-run" },
  });
  t.journal.push({
    seq: 8,
    owner: "cancel",
    phase: "cancel",
    probe: "cancel",
    kind: "activation",
    label: "cancel",
    verb: "key",
    outcome: "completed",
  });
  expect(assessEditingTrial(definition, t).observations).toEqual({
    save: "pass",
    cancel: "fail",
    undo: "not-run",
  });
});
it("requires a setup detail replacement from the same cancellation clone", () => {
  const { t, task } = threeProbeTrial();
  const url =
    "http://localhost/api/document/state?path=literal-project&phase=detail";
  t.journal.push(
    {
      seq: 11,
      owner: "cancel",
      phase: "setup",
      probe: "short",
      kind: "read-request",
      requestId: 20,
      method: "GET",
      url,
    },
    {
      seq: 12,
      owner: "cancel",
      phase: "setup",
      probe: "short",
      kind: "read-failed",
      requestId: 20,
      error: "net::ERR_ABORTED",
    },
    {
      seq: 13,
      owner: "cancel",
      phase: "setup",
      probe: "vertical",
      kind: "read-request",
      requestId: 21,
      method: "GET",
      url,
    },
    {
      seq: 14,
      owner: "cancel",
      phase: "setup",
      probe: "vertical",
      kind: "read-response",
      requestId: 21,
      status: 200,
      body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
    },
  );
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    canceledReads: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
  for (const row of t.journal)
    if (row.owner === "cancel" && row.seq >= 13) row.probe = "short";
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "pass",
    completedWork: 1,
    canceledReads: 1,
    observations: { save: "pass", cancel: "pass", undo: "pass" },
  });
});
it.each(["journal", "failure", "ui"])(
  "keeps unexpected syntactically valid probe %s evidence owned by Cancel",
  (source) => {
    const t = trial();
    const origin = {
      owner: "cancel" as const,
      phase: "cancel" as const,
      probe: "not-declared",
    };
    if (source === "journal") Object.assign(t.journal[3], origin);
    if (source === "failure")
      t.failures.push({
        origin,
        error: "literal undeclared clone failure",
        errorName: null,
      });
    if (source === "ui")
      t.uiEvidence = [
        { origin, stage: "literal unexpected clone", geometry: {} },
      ];
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations: { save: "pass", cancel: "fail", undo: "pass" },
    });
  },
);
it("keeps cancellation-wide context failures independent of valid main proof", () => {
  const t = trial();
  t.failures.push({
    origin: { owner: "cancel", phase: "cancel", probe: null },
    error: "literal context failure",
    errorName: "Error",
  });
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
