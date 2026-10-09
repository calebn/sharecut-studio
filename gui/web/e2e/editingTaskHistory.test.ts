import { expect, it } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import { assessEditingTrial } from "./editingTaskReport";
import { definition, trial } from "./editingTaskTestFixtures";

it("rejects missing or unchanged History", () => {
  const t = trial();
  delete t.history;
  expect(assessEditingTrial(definition, t).status).toBe("fail");
  const empty = { cursor: -1, headId: null, entries: [] };
  t.history = { before: empty, after: empty, undone: empty };
  expect(assessEditingTrial(definition, t).status).toBe("fail");
});
it("admits materialized baseline and preserved Redo, and initialized History", () => {
  const t = trial();
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  t.history!.before = t.history!.undone;
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  t.history!.undone = {
    ...t.history!.undone!,
    entries: t.history!.undone!.entries.slice(0, 1),
  };
  expect(assessEditingTrial(definition, t).reasons).toContain(
    "History Undo transition differs",
  );
});
it("requires separate resolve and unresolve comment History mutations", () => {
  const task = editingTaskRegistry.find((row) => row.id === "comment")!;
  const t = trial();
  Object.assign(t, {
    task: "comment",
    route: "resolve-button",
    cancellations: [],
    before: task.start,
    after: task.expected,
    undone: task.start,
  });
  t.journal = t.journal.filter((row) => row.owner !== "cancel");
  for (const row of t.journal)
    if (row.kind === "request") row.type = "ResolveComment";
  const baseline = {
    id: "baseline",
    label: "before resolve comment",
    operation: null,
  };
  const resolved = {
    id: "resolved",
    label: "after resolve comment",
    operation: null,
  };
  const restored = {
    id: "restored",
    label: "after unresolve comment",
    operation: null,
  };
  t.history = {
    before: { cursor: -1, headId: null, entries: [] },
    after: { cursor: 1, headId: "resolved", entries: [baseline, resolved] },
    undone: {
      cursor: 2,
      headId: "restored",
      entries: [baseline, resolved, restored],
    },
  };
  expect(assessEditingTrial(task, t).status).toBe("pass");
  t.history.undone = {
    cursor: 0,
    headId: "baseline",
    entries: [baseline, resolved],
  };
  expect(assessEditingTrial(task, t).reasons).toContain(
    "Comment toast History transition differs",
  );
});
it("checks saved History even when Undo identity is invalid", () => {
  const t = trial();
  t.history!.undone = null;
  t.history!.after!.entries[1].operation = "wrong-operation";
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "pass", undo: "fail" },
  });
  t.history!.after!.entries[1].operation = "trim_clip_edge";
  expect(assessEditingTrial(definition, t).observations).toEqual({
    save: "pass",
    cancel: "pass",
    undo: "fail",
  });
});
