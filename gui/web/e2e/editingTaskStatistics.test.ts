import { expect, it } from "vitest";
import {
  assessEditingTrial,
  summarizeEditingAttempts,
} from "./editingTaskReport";
import { definition, trial } from "./editingTaskTestFixtures";

it("excludes diagnostic and non-finite durations from five-trial statistics", () => {
  const rows = [
    {
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs: NaN,
    },
    ...[1, 2, 3, 4].map((durationMs) => ({
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs,
    })),
    {
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "diagnostic" as const,
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
      baselineValid: 4,
      duration: null,
    },
  ]);
  rows.push({
    task: "trim",
    route: "keyboard",
    valid: true,
    mode: "baseline",
    durationMs: 5,
  });
  expect(summarizeEditingAttempts([definition], rows)[0].duration).toEqual({
    medianMs: 3,
    minMs: 1,
    maxMs: 5,
  });
});
it("excludes negative and missing elapsed durations from baseline admission", () => {
  const rows = [-10, undefined, NaN, Infinity, 0, 1, 2, 3, 4].map(
    (durationMs) => ({
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs,
    }),
  );
  expect(summarizeEditingAttempts([definition], rows)[0]).toMatchObject({
    status: "fail",
    valid: 5,
    failed: 4,
    baselineValid: 5,
    duration: { medianMs: 2, minMs: 0, maxMs: 4 },
  });
});
it.each([undefined, -10, NaN, Infinity, "10", null])(
  "rejects elapsed duration %s independently",
  (durationMs) => {
    const t = trial();
    Object.assign(t, { durationMs });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
