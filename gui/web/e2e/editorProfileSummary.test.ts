import { describe, expect, it } from "vitest";
import {
  type EditorProfileReport,
  measured,
  statistics,
  unavailable,
} from "./editorProfileReport";
import { formatSummary, summaryRows } from "./editorProfileSummary";

function report(
  run: number,
  driverWallMs: number,
  overrides: Partial<EditorProfileReport> = {},
): EditorProfileReport {
  const intervals = [16.6, 16.7, 33.4];
  return {
    schemaVersion: 1,
    execution: { id: `run-${run}`, startedAt: "2026-10-13T00:00:00Z" },
    measurementVersion: "editor-workloads-v2",
    status: "complete",
    fixture: { preset: "small", canonicalSha256: "ab".repeat(32) },
    environment: {
      revision: "0123456789abcdef0123",
      dirty: false,
      node: "v24",
      host: {
        hostname: "h",
        os: "darwin 25",
        architecture: "arm64",
        cpuModel: "Test CPU",
        logicalCpus: 8,
        memoryBytes: 1,
      },
      browser: "Chromium 140",
      viewport: { width: 1280, height: 720 },
      headless: true,
      page: measured(
        {
          theme: "light",
          reducedMotion: true,
          deviceScale: 1,
          hardwareConcurrency: 8,
        },
        "actual page settings",
      ),
    },
    protocol: { scenario: "seek", repeatIndex: run },
    samples: [
      {
        id: "ruler-seek",
        phase: "warm",
        input: "click",
        iteration: 1,
        result: { status: "completed", observation: { kind: "seek" } },
        driverWallMs,
        frames: measured(
          {
            intervalsMs: intervals,
            capped: false,
            longTaskDurationsMs: [60],
            longTasksSupported: true,
            statistics: statistics(intervals),
          },
          "rAF",
        ),
        longTasks: measured(
          { count: 1, totalMs: 60, maximumMs: 60 },
          "longtask",
        ),
        cdp: {
          TaskDuration: measured(12.34, "cdp"),
          ScriptDuration: measured(5, "cdp"),
          LayoutDuration: unavailable("reset"),
          RecalcStyleDuration: measured(1.25, "cdp"),
        },
      },
    ],
    errors: [],
    ...overrides,
  } as unknown as EditorProfileReport;
}

describe("editor profile summary", () => {
  it("turns a sample into one row and keeps unavailable counters explicit", () => {
    const [row] = summaryRows(report(1, 250.4));
    expect(row).toEqual({
      run: 1,
      scene: "seek",
      sample: "ruler-seek",
      status: "completed",
      driverMs: 250.4,
      frames: 3,
      frameMedianMs: 16.7,
      frameP95Ms: 33.4,
      frameMaxMs: 33.4,
      longTasks: 1,
      longTaskTotalMs: 60,
      taskMs: 12.34,
      scriptMs: 5,
      layoutMs: null,
      styleMs: 1.25,
    });
  });

  it("prints the environment, a table with n/a for missing counters, and the spread across runs", () => {
    const text = formatSummary([report(1, 250.4), report(2, 310.6)]);
    expect(text).toContain("revision 0123456789ab");
    expect(text).toContain("page theme light, reduced motion true");
    expect(text).toContain("1280x720");
    expect(text).toContain("fixture small sha256 abababababab");
    expect(text).toContain("2 report(s), 0 incomplete");
    expect(text).toMatch(/seek\s+1\s+ruler-seek\s+completed\s+250\s+3\s+16\.7/);
    expect(text).toMatch(/layout ms/);
    expect(text).toMatch(/\bn\/a\b/);
    expect(text).toContain("seek/ruler-seek: 250, 311 (min 250, max 311)");
    expect(text).toContain("not input-to-visual latency");
  });

  it("flags an incomplete run and its reason", () => {
    const text = formatSummary([
      report(1, 100, { status: "incomplete", errors: ["trim failed"] }),
    ]);
    expect(text).toContain("1 report(s), 1 incomplete");
    expect(text).toContain("INCOMPLETE seek run 1: trim failed");
  });
});
