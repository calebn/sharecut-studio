import { expect, it } from "vitest";
import {
  assessEditingTrial,
  type EditingSummaryAttempt,
  summarizeEditingAttempts,
} from "./editingTaskReport";
import { definition, trial } from "./editingTaskTestFixtures";

it("counts finalized admissions and excludes diagnostic values from baseline statistics", () => {
  const rows: EditingSummaryAttempt[] = [
    {
      task: "trim",
      route: "keyboard",
      trial: 1,
      kind: "rejected",
      mode: "baseline",
    },
    ...[1, 2, 3, 4].map((durationMs, index) => ({
      task: "trim",
      route: "keyboard",
      trial: index + 2,
      kind: "admitted" as const,
      mode: "baseline" as const,
      durationMs,
    })),
    {
      task: "trim",
      route: "keyboard",
      trial: 6,
      kind: "admitted",
      mode: "diagnostic",
      durationMs: 99,
    },
  ];
  expect(summarizeEditingAttempts([definition], rows)).toEqual([
    {
      task: "trim",
      route: "keyboard",
      status: "fail",
      reason: "Fewer than five valid baseline trials",
      attempted: 6,
      valid: 5,
      failed: 1,
      notRun: 0,
      baselineValid: 4,
      duration: null,
    },
  ]);
  rows.push({
    task: "trim",
    route: "keyboard",
    trial: 7,
    kind: "admitted",
    mode: "baseline",
    durationMs: 5,
  });
  expect(summarizeEditingAttempts([definition], rows)[0].duration).toEqual({
    medianMs: 3,
    minMs: 1,
    maxMs: 5,
  });
});
it("keeps rejected elapsed receipts out of duration while admitting zero", () => {
  const rows: EditingSummaryAttempt[] = [
    ...[1, 2, 3, 4].map((trial) => ({
      task: "trim",
      route: "keyboard",
      trial,
      kind: "rejected" as const,
      mode: "baseline" as const,
    })),
    ...[0, 1, 2, 3, 4].map((durationMs, index) => ({
      task: "trim",
      route: "keyboard",
      trial: index + 5,
      kind: "admitted" as const,
      mode: "baseline" as const,
      durationMs,
    })),
  ];
  expect(summarizeEditingAttempts([definition], rows)[0]).toMatchObject({
    status: "fail",
    attempted: 9,
    valid: 5,
    failed: 4,
    notRun: 0,
    baselineValid: 5,
    duration: { medianMs: 2, minMs: 0, maxMs: 4 },
  });
});
it("counts one rejected invocation and four untouched scheduled slots", () => {
  const rows: EditingSummaryAttempt[] = [
    {
      task: "trim",
      route: "keyboard",
      trial: 1,
      kind: "rejected",
      mode: "baseline",
    },
    ...[2, 3, 4, 5].map((trial) => ({
      task: "trim",
      route: "keyboard",
      trial,
      kind: "not-run" as const,
      reason: "Stopped after literal cleanup rejection",
    })),
  ];
  expect(summarizeEditingAttempts([definition], rows)).toEqual([
    {
      task: "trim",
      route: "keyboard",
      status: "fail",
      reason: "Stopped after literal cleanup rejection",
      attempted: 1,
      valid: 0,
      failed: 1,
      notRun: 4,
      baselineValid: 0,
      duration: null,
    },
  ]);
});
it("keeps untouched, unselected and pending routes distinct", () => {
  const selected = {
    ...definition,
    routes: [
      definition.routes[0],
      { ...definition.routes[0], id: "unselected" },
      { id: "future", pending: "Literal unsupported route" },
    ],
  };
  const rows: EditingSummaryAttempt[] = [1, 2, 3, 4, 5].map((trial) => ({
    task: "trim",
    route: "keyboard",
    trial,
    kind: "not-run",
    reason: "Stopped before literal invocation",
  }));
  expect(summarizeEditingAttempts([selected], rows)).toEqual([
    {
      task: "trim",
      route: "keyboard",
      status: "not-run",
      reason: "Stopped before literal invocation",
      attempted: 0,
      valid: 0,
      failed: 0,
      notRun: 5,
      baselineValid: 0,
      duration: null,
    },
    {
      task: "trim",
      route: "unselected",
      status: "not-run",
      reason: "No scheduled attempt",
      attempted: 0,
      valid: 0,
      failed: 0,
      notRun: 0,
      baselineValid: 0,
      duration: null,
    },
    {
      task: "trim",
      route: "future",
      status: "pending",
      reason: "Literal unsupported route",
      attempted: 0,
      valid: 0,
      failed: 0,
      notRun: 0,
      baselineValid: 0,
      duration: null,
    },
  ]);
});
it.each([undefined, -10, NaN, Infinity, "10", null])(
  "rejects elapsed duration %s independently",
  (durationMs) => {
    const t = trial();
    Object.assign(t, { durationMs });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it("admits literal zero elapsed time through the canonical semantic assessor", () => {
  const t = trial();
  t.durationMs = 0;
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "pass",
    completedWork: 1,
  });
});
