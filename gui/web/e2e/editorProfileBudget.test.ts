import { describe, expect, it } from "vitest";
import {
  applyDiagnosticBudget,
  budgetCompatibility,
  diagnosticEnvelope,
  freezeDiagnosticBudget,
  independenceReasons,
  metricReasons,
  type ProfileEvidence,
  primaryMetrics,
} from "./editorProfileBudget";
import {
  completionReasons,
  type EditorProfileReport,
  FRAME_PERCENTILE_POLICY,
  measured,
  unavailable,
} from "./editorProfileReport";

describe("local diagnostic budgets", () => {
  it("freezes a literal variance envelope before checking independent observations", () => {
    expect(diagnosticEnvelope([10, 12, 11, 14, 13], [17, 16])).toMatchObject({
      maximum: 14,
      adjacentVariation: 3,
      limit: 17,
      stable: true,
    });
    expect(diagnosticEnvelope([10, 12, 11, 14, 13], [18])).toMatchObject({
      limit: 17,
      stable: false,
    });
  });
  it("refuses insufficient repetitions and invalid metric values", () => {
    for (const values of [
      [1, 2],
      [1, 2, NaN, 4, 5],
      [1, 2, -1, 4, 5],
    ])
      expect(() => diagnosticEnvelope(values, [1])).toThrow();
    expect(() => diagnosticEnvelope([1, 2, 3, 4, 5], [])).toThrow();
  });
  it("keeps traced diagnostic windows out of primary timing budgets", () => {
    const report = {
      samples: [
        {
          id: "progress",
          phase: "diagnostic",
          iteration: 1,
          driverWallMs: 9999,
        },
      ],
      memory: [],
    } as unknown as EditorProfileReport;
    expect(primaryMetrics(report)).toEqual({});
    report.samples = [
      {
        id: "progress",
        phase: "warm",
        iteration: 1,
        driverWallMs: 12,
        frames: { status: "unavailable", reason: "missing" },
        longTasks: { status: "unavailable", reason: "missing" },
        cdp: {},
      },
    ] as EditorProfileReport["samples"];
    expect(primaryMetrics(report)).toEqual({ "progress/1/wall-ms": 12 });
  });
  it("refuses copied executions and duplicate real report paths", () => {
    const a = {
      execution: { id: "one", startedAt: "2026-10-03T00:00:00Z" },
    } as EditorProfileReport;
    const b = {
      execution: { id: "two", startedAt: "2026-10-03T00:00:01Z" },
    } as EditorProfileReport;
    expect(
      independenceReasons([
        { file: "/base/report.json", report: a },
        { file: "/hold/report.json", report: a },
      ]),
    ).toEqual([
      "/hold/report.json: duplicate execution identity; copied reports are not independent",
    ]);
    expect(
      independenceReasons([
        { file: "/base/report.json", report: a },
        { file: "/base/report.json", report: b },
      ]),
    ).toEqual(["/base/report.json: duplicate report path"]);
    expect(
      independenceReasons([
        { file: "/base/report.json", report: a },
        { file: "/hold/report.json", report: b },
      ]),
    ).toEqual([]);
  });
  it("requires both recorded success and declared coverage; not-run cannot complete", () => {
    const report = {
      measurementVersion: "editor-workloads-v2",
      protocol: { requiredCoverage: ["cold-waveform"], resources: {} },
      coverage: [
        {
          id: "cold-waveform",
          result: { status: "not-run", reason: "missing" },
        },
      ],
      samples: [],
    } as unknown as EditorProfileReport;
    expect(completionReasons(report)).toEqual([
      "required workload incomplete: cold-waveform",
    ]);
    report.coverage[0]!.result = {
      status: "completed",
      observation: { kind: "existing", contract: "fake coverage" },
    };
    expect(completionReasons(report)).toEqual([
      "required workload incomplete: cold-waveform",
    ]);
    report.samples = [
      { id: "cold-waveform", result: report.coverage[0]!.result },
    ] as EditorProfileReport["samples"];
    expect(completionReasons(report)).toEqual([]);
  });
});

function evidence(id: string, seconds: number, wall: number): ProfileEvidence {
  const result = {
    status: "completed",
    observation: { kind: "existing", contract: "literal metric fixture" },
  };
  const report = {
    schemaVersion: 1,
    measurementVersion: "editor-workloads-v2",
    status: "complete",
    execution: {
      id,
      startedAt: new Date(Date.UTC(2026, 9, 3, 0, 0, seconds)).toISOString(),
    },
    fixture: {
      preset: "small",
      canonicalSha256: "fixture",
      waveforms: measured([], "literal identity"),
    },
    environment: {
      revision: "clean-head",
      dirty: false,
      node: "24",
      host: { cpuModel: "test-cpu" },
      browser: "test-browser",
      viewport: { width: 1280, height: 720 },
      headless: true,
      page: measured({ theme: "dark" }, "literal"),
      build: measured(
        {
          mode: "production",
          e2eHooks: false,
          assets: [{ path: "/assets/index.js", sha256: "build" }],
        },
        "literal",
      ),
    },
    protocol: {
      scenario: "playback",
      requiredCoverage: ["playback"],
      resources: {},
      repeatIndex: 1,
      framePercentiles: FRAME_PERCENTILE_POLICY,
    },
    coverage: [{ id: "playback", result }],
    memory: [],
    samples: [
      {
        id: "playback",
        iteration: 1,
        phase: "warm",
        input: "fixed input",
        result,
        driverWallMs: wall,
        frames: measured(
          {
            intervalsMs: [16, 16],
            longTaskDurationsMs: [],
            longTasksSupported: true,
            capped: false,
            statistics: { count: 2, medianMs: 16, p95Ms: 16, maximumMs: 16 },
          },
          "literal frame intervals",
        ),
        longTasks: unavailable("literal"),
        cdp: { TaskDuration: measured(5, "literal") },
      },
    ],
  } as unknown as EditorProfileReport;
  return { file: `/reports/${id}/report.json`, sha256: `hash-${id}`, report };
}
function cohort() {
  const baseline = [10, 12, 11, 14, 13].map((value, index) =>
    evidence(`base-${index}`, index, value),
  );
  const holdout = [evidence("holdout", 10, 16)];
  return {
    baseline,
    holdout,
    budget: freezeDiagnosticBudget(baseline, holdout),
  };
}
describe("predeclared frame percentile applicability", () => {
  it("retains raw atomic-save frames while excluding their percentile budget", () => {
    for (const intervalsMs of [[], [16], [16, 16]]) {
      const entry = evidence("atomic", 20, 10);
      const sample = entry.report.samples[0]!;
      sample.id = "clip-drag-save";
      sample.frames = measured(
        {
          intervalsMs,
          longTaskDurationsMs: [],
          longTasksSupported: true,
          capped: false,
          statistics: intervalsMs.length
            ? {
                count: intervalsMs.length,
                medianMs: 16,
                p95Ms: 16,
                maximumMs: 16,
              }
            : { count: 0, medianMs: null, p95Ms: null, maximumMs: null },
        },
        "literal atomic frame intervals",
      );
      expect(Object.keys(primaryMetrics(entry.report))).toEqual([
        "clip-drag-save/1/wall-ms",
        "clip-drag-save/1/mainthread-ms",
      ]);
      expect(sample.frames).toMatchObject({ value: { intervalsMs } });
      expect(metricReasons(entry.report)).toEqual([]);
    }
  });
  it("refuses unavailable, capped, or undersampled required frame windows", () => {
    const { baseline, holdout } = cohort();
    for (const frames of [
      unavailable("no recorder"),
      measured(
        {
          intervalsMs: [16],
          longTaskDurationsMs: [],
          longTasksSupported: true,
          capped: false,
          statistics: { count: 1, medianMs: 16, p95Ms: 16, maximumMs: 16 },
        },
        "one interval",
      ),
      measured(
        {
          intervalsMs: [16, 16],
          longTaskDurationsMs: [],
          longTasksSupported: true,
          capped: true,
          statistics: { count: 2, medianMs: 16, p95Ms: 16, maximumMs: 16 },
        },
        "truncated",
      ),
    ]) {
      baseline[0]!.report.samples[0]!.frames = frames;
      expect(metricReasons(baseline[0]!.report)).toContain(
        "required frame percentile unavailable: playback",
      );
      expect(freezeDiagnosticBudget(baseline, holdout).status).toBe("invalid");
    }
  });
});

describe("frozen diagnostic budget application", () => {
  it("rejects altered finite limits and false holdout stability without recalibrating", () => {
    const { baseline, holdout, budget } = cohort();
    const candidate = evidence("candidate", 20, 18);
    const inflated = structuredClone(budget);
    inflated.groups[0]!.metrics[0]!.limit = 100;
    expect(
      applyDiagnosticBudget(inflated, [...baseline, ...holdout], [candidate])
        .errors,
    ).toContain(
      "small/playback: frozen derivation changed: playback/1/wall-ms",
    );
    const falseStability = structuredClone(budget);
    const changedHoldout = structuredClone(holdout);
    changedHoldout[0]!.report.samples[0]!.driverWallMs = 18;
    falseStability.groups[0]!.metrics[0]!.holdout = [18];
    expect(
      applyDiagnosticBudget(
        falseStability,
        [...baseline, ...changedHoldout],
        [candidate],
      ).errors,
    ).toContain(
      "small/playback: frozen derivation changed: playback/1/wall-ms",
    );
    expect(budget.groups[0]!.metrics[0]!.limit).toBe(17);
    expect(candidate.report.samples[0]!.driverWallMs).toBe(18);
  });
  it("requires the frozen baseline references to retain chronological order", () => {
    const { baseline, holdout, budget } = cohort();
    const reordered = structuredClone(budget);
    reordered.groups[0]!.baseline.reverse();
    for (const metric of reordered.groups[0]!.metrics)
      metric.baseline.reverse();
    expect(
      applyDiagnosticBudget(
        reordered,
        [...baseline, ...holdout],
        [evidence("candidate", 20, 10)],
      ).errors,
    ).toContain("small/playback: frozen baseline ordering changed");
  });
  it("rejects a deleted metric or changed declared values against pinned originals", () => {
    const { baseline, holdout, budget } = cohort();
    const candidate = evidence("candidate", 20, 10);
    const partial = structuredClone(budget);
    partial.groups[0]!.metrics.splice(0, 1);
    expect(
      applyDiagnosticBudget(partial, [...baseline, ...holdout], [candidate])
        .errors,
    ).toContain(
      "small/playback: frozen metric definitions differ from original report",
    );
    const altered = structuredClone(budget);
    altered.groups[0]!.metrics[0]!.baseline[0] = 999;
    expect(
      applyDiagnosticBudget(altered, [...baseline, ...holdout], [candidate])
        .errors,
    ).toContain(
      "small/playback: frozen metric values differ from original reports: playback/1/wall-ms",
    );
    expect(budget.groups[0]!.metrics[0]!.limit).toBe(17);
  });
  it("rejects stripped budgets, missing candidates, and duplicate frozen evidence", () => {
    const { baseline, holdout, budget } = cohort();
    const candidate = evidence("candidate", 20, 10);
    for (const mutate of [
      (value: typeof budget) => {
        value.groups = [];
      },
      (value: typeof budget) => {
        value.groups[0]!.baseline = [];
        value.groups[0]!.holdout = [];
      },
      (value: typeof budget) => {
        value.groups[0]!.baseline.splice(1);
      },
      (value: typeof budget) => {
        value.groups[0]!.metrics = [];
      },
      (value: typeof budget) => {
        value.groups[0]!.metrics.push(value.groups[0]!.metrics[0]!);
      },
      (value: typeof budget) => {
        value.groups[0]!.holdout = [value.groups[0]!.baseline[0]!];
      },
    ]) {
      const stripped = structuredClone(budget);
      mutate(stripped);
      expect(
        applyDiagnosticBudget(stripped, [...baseline, ...holdout], [candidate])
          .status,
      ).toBe("invalid");
    }
    expect(
      applyDiagnosticBudget(budget, [...baseline, ...holdout], []).errors,
    ).toContain("no candidate reports");
    expect(applyDiagnosticBudget(budget, [], [candidate]).errors).toContain(
      "small/playback: frozen baseline report missing",
    );
    const malformed = structuredClone(budget);
    malformed.groups[0]!.baseline = undefined as never;
    expect(
      applyDiagnosticBudget(malformed, [...baseline, ...holdout], [candidate])
        .errors,
    ).toContain("invalid frozen budget shape");
  });
  it("rejects invalid candidate execution timestamps", () => {
    const { baseline, holdout, budget } = cohort();
    const candidate = evidence("candidate", 20, 10);
    candidate.report.execution.startedAt = "not a time";
    expect(
      applyDiagnosticBudget(budget, [...baseline, ...holdout], [candidate])
        .errors,
    ).toContain("/reports/candidate/report.json: invalid execution start time");
  });
  it("applies unchanged reviewed limits and verifies original report digests", () => {
    const { baseline, holdout, budget } = cohort();
    expect(budget.status).toBe("validated");
    expect(budget.groups[0]!.metrics[0]!.limit).toBe(17);
    const candidate = evidence("candidate", 20, 18);
    const result = applyDiagnosticBudget(
      budget,
      [...baseline, ...holdout],
      [candidate],
    );
    expect(result.status).toBe("diagnostic-exceeded");
    expect(result.groups[0]!.observations[0]).toMatchObject({
      value: 18,
      limit: 17,
      exceeds: true,
    });
    const altered = structuredClone(baseline);
    altered[0]!.sha256 = "changed bytes";
    expect(
      applyDiagnosticBudget(budget, [...altered, ...holdout], [candidate])
        .errors,
    ).toContain(
      "/reports/base-0/report.json: frozen report identity/content changed",
    );
    expect(budget.groups[0]!.metrics[0]!.limit).toBe(17);
  });
  it("refuses malformed candidate values instead of comparison coercion", () => {
    const { baseline, holdout, budget } = cohort();
    for (const value of [null, undefined, -1, NaN, Infinity]) {
      const candidate = evidence("candidate", 20, 10);
      candidate.report.samples[0]!.driverWallMs = value as number;
      expect(metricReasons(candidate.report)).toContain(
        "invalid primary metric: playback/1/wall-ms",
      );
      expect(
        applyDiagnosticBudget(budget, [...baseline, ...holdout], [candidate])
          .status,
      ).toBe("invalid");
    }
  });
  it("refuses null raw memory and negative measured counters before coercion", () => {
    const { baseline, holdout } = cohort();
    const candidate = evidence("candidate", 20, 10);
    for (const entry of [...baseline, ...holdout, candidate])
      entry.report.memory = [
        { label: "before", heapBytes: 100, domNodes: 10 },
        { label: "after", heapBytes: 110, domNodes: 12 },
      ] as EditorProfileReport["memory"];
    const budget = freezeDiagnosticBudget(baseline, holdout);
    expect(budget.status).toBe("validated");
    candidate.report.memory = [
      { label: "before", heapBytes: null, domNodes: 10 },
      { label: "after", heapBytes: null, domNodes: 10 },
    ] as unknown as EditorProfileReport["memory"];
    expect(metricReasons(candidate.report)).toContain(
      "invalid memory checkpoint: before",
    );
    expect(
      applyDiagnosticBudget(budget, [...baseline, ...holdout], [candidate])
        .status,
    ).toBe("invalid");
    candidate.report.memory = structuredClone(baseline[0]!.report.memory);
    candidate.report.samples[0]!.cdp.LayoutDuration = measured(
      -1,
      "malformed candidate",
    );
    expect(metricReasons(candidate.report)).toContain(
      "invalid measured counter: playback/LayoutDuration",
    );
    expect(
      applyDiagnosticBudget(budget, [...baseline, ...holdout], [candidate])
        .status,
    ).toBe("invalid");
  });
  it("rejects diagnostic-only candidates and ambiguous baseline ordering", () => {
    const { baseline, holdout } = cohort();
    const diagnostic = evidence("diagnostic", 20, 10);
    diagnostic.report.samples[0]!.phase = "diagnostic";
    expect(
      budgetCompatibility(baseline[0]!.report, diagnostic.report),
    ).toContain("no primary measurements");
    baseline[1]!.report.execution.startedAt =
      baseline[0]!.report.execution.startedAt;
    expect(freezeDiagnosticBudget(baseline, holdout).errors).toContain(
      "small/playback: ambiguous baseline execution ordering",
    );
  });
  it("refuses an unstable frozen budget and a copied candidate execution", () => {
    const { baseline, holdout, budget } = cohort();
    const unstable = structuredClone(budget);
    unstable.status = "unstable-baseline";
    expect(
      applyDiagnosticBudget(
        unstable,
        [...baseline, ...holdout],
        [evidence("candidate", 20, 10)],
      ).errors,
    ).toContain("budget is not validated");
    expect(
      applyDiagnosticBudget(budget, [...baseline, ...holdout], [baseline[0]!])
        .status,
    ).toBe("invalid");
  });
});
