import type { EditorProfileReport, Measurement } from "./editorProfileReport";

export type SummaryRow = {
  run: number;
  scene: string;
  sample: string;
  status: "completed" | "failed" | "not-run";
  driverMs: number;
  frames: number | null;
  frameMedianMs: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  longTasks: number | null;
  longTaskTotalMs: number | null;
  taskMs: number | null;
  scriptMs: number | null;
  layoutMs: number | null;
  styleMs: number | null;
};

const value = <T>(measurement: Measurement<T> | undefined): T | null =>
  measurement?.status === "measured" ? measurement.value : null;

export function summaryRows(report: EditorProfileReport): SummaryRow[] {
  return report.samples.map((sample) => {
    const frames = value(sample.frames);
    const longTasks = value(sample.longTasks);
    return {
      run: report.protocol.repeatIndex,
      scene: report.protocol.scenario ?? "legacy",
      sample: sample.id,
      status: sample.result.status,
      driverMs: sample.driverWallMs,
      frames: frames?.statistics.count ?? null,
      frameMedianMs: frames?.statistics.medianMs ?? null,
      frameP95Ms: frames?.statistics.p95Ms ?? null,
      frameMaxMs: frames?.statistics.maximumMs ?? null,
      longTasks: longTasks?.count ?? null,
      longTaskTotalMs: longTasks?.totalMs ?? null,
      taskMs: value(sample.cdp.TaskDuration),
      scriptMs: value(sample.cdp.ScriptDuration),
      layoutMs: value(sample.cdp.LayoutDuration),
      styleMs: value(sample.cdp.RecalcStyleDuration),
    };
  });
}

const cell = (n: number | null, digits = 1) =>
  n === null ? "n/a" : n.toFixed(digits);

const COLUMNS: [string, (row: SummaryRow) => string][] = [
  ["scene", (r) => r.scene],
  ["run", (r) => String(r.run)],
  ["sample", (r) => r.sample],
  ["status", (r) => r.status],
  ["driver ms", (r) => cell(r.driverMs, 0)],
  ["frames", (r) => cell(r.frames, 0)],
  ["frame p50", (r) => cell(r.frameMedianMs)],
  ["frame p95", (r) => cell(r.frameP95Ms)],
  ["frame max", (r) => cell(r.frameMaxMs)],
  ["long tasks", (r) => cell(r.longTasks, 0)],
  ["long ms", (r) => cell(r.longTaskTotalMs)],
  ["task ms", (r) => cell(r.taskMs)],
  ["script ms", (r) => cell(r.scriptMs)],
  ["layout ms", (r) => cell(r.layoutMs)],
  ["style ms", (r) => cell(r.styleMs)],
];

function table(rows: SummaryRow[]): string[] {
  const grid = [
    COLUMNS.map(([name]) => name),
    ...rows.map((row) => COLUMNS.map(([, format]) => format(row))),
  ];
  const widths = COLUMNS.map((_, i) =>
    Math.max(...grid.map((line) => line[i]!.length)),
  );
  return grid.map((line) =>
    line.map((text, i) => text.padStart(widths[i]!)).join("  "),
  );
}

export function environmentLines(report: EditorProfileReport): string[] {
  const page = value(report.environment.page);
  const { host, viewport } = report.environment;
  return [
    `revision ${report.environment.revision.slice(0, 12)}${report.environment.dirty ? " (dirty worktree)" : ""}`,
    `browser ${report.environment.browser}, headless ${String(report.environment.headless)}, viewport ${viewport ? `${viewport.width}x${viewport.height}` : "unknown"}`,
    `page theme ${page?.theme ?? "n/a"}, reduced motion ${page ? String(page.reducedMotion) : "n/a"}`,
    `host ${host.os} ${host.architecture}, ${host.cpuModel ?? "unknown cpu"}, ${host.logicalCpus} logical cpus`,
    `fixture ${report.fixture.preset} sha256 ${report.fixture.canonicalSha256.slice(0, 12)}`,
  ];
}

export function formatSummary(reports: EditorProfileReport[]): string {
  const rows = reports
    .flatMap(summaryRows)
    .sort(
      (a, b) =>
        a.scene.localeCompare(b.scene) ||
        a.sample.localeCompare(b.sample) ||
        a.run - b.run,
    );
  const out: string[] = [];
  const first = reports[0];
  if (first) out.push(...environmentLines(first), "");
  const incomplete = reports.filter((report) => report.status !== "complete");
  out.push(
    `${reports.length} report(s), ${incomplete.length} incomplete${incomplete.length ? ": a failed task supplies no passing result" : ""}`,
    "",
    ...table(rows),
    "",
    "driver ms is Playwright driver wall time for the whole task, not input-to-visual latency.",
    "frame columns are page rAF intervals (ms) inside the sample window; long tasks are main-thread tasks over 50 ms.",
    "task/script/layout/style ms are CDP Performance counter deltas and overlap.",
  );
  const spread = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.scene}/${row.sample}`;
    spread.set(key, [...(spread.get(key) ?? []), row.driverMs]);
  }
  const repeated = [...spread].filter(([, values]) => values.length > 1);
  if (repeated.length) {
    out.push("", "driver ms across runs with identical inputs:");
    for (const [key, values] of repeated)
      out.push(
        `  ${key}: ${values.map((v) => v.toFixed(0)).join(", ")} (min ${Math.min(...values).toFixed(0)}, max ${Math.max(...values).toFixed(0)})`,
      );
  }
  for (const report of incomplete)
    out.push(
      "",
      `INCOMPLETE ${report.protocol.scenario ?? "legacy"} run ${report.protocol.repeatIndex}: ${report.errors.join("; ") || "a sample failed"}`,
    );
  return `${out.join("\n")}\n`;
}
