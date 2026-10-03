import {
  compatibilityReasons,
  type EditorProfileReport,
  FRAME_PERCENTILE_POLICY,
} from "./editorProfileReport";

export function diagnosticEnvelope(
  baseline: readonly number[],
  holdout: readonly number[],
) {
  if (
    baseline.length < 5 ||
    !holdout.length ||
    [...baseline, ...holdout].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    throw new Error(
      "Need five finite nonnegative baseline values and an independent holdout",
    );
  const maximum = Math.max(...baseline);
  const adjacentVariation = Math.max(
    ...baseline.slice(1).map((value, i) => Math.abs(value - baseline[i]!)),
  );
  const limit = maximum + adjacentVariation;
  return {
    maximum,
    adjacentVariation,
    limit,
    holdout,
    stable: holdout.every((value) => value <= limit),
    method:
      "baseline maximum + largest adjacent absolute difference; independent holdout; local diagnostic envelope, not SLA",
  };
}

export function primaryMetrics(
  report: EditorProfileReport,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const sample of report.samples) {
    if (sample.phase === "diagnostic") continue;
    const key = `${sample.id}/${sample.iteration}`;
    metrics[`${key}/wall-ms`] = sample.driverWallMs;
    if (
      (FRAME_PERCENTILE_POLICY.workloadIds as readonly string[]).includes(
        sample.id,
      ) &&
      sample.frames.status === "measured" &&
      !sample.frames.value.capped &&
      sample.frames.value.statistics.count >=
        FRAME_PERCENTILE_POLICY.minimumIntervals &&
      sample.frames.value.statistics.p95Ms !== null
    )
      metrics[`${key}/raf-p95-ms`] = sample.frames.value.statistics.p95Ms;
    if (sample.longTasks.status === "measured")
      metrics[`${key}/longtask-ms`] = sample.longTasks.value.totalMs;
    const task = sample.cdp.TaskDuration;
    if (task?.status === "measured")
      metrics[`${key}/mainthread-ms`] = task.value;
  }
  if (report.memory.length >= 2) {
    const first = report.memory[0]!,
      last = report.memory.at(-1)!;
    metrics["post-gc/heap-growth-bytes"] = Math.max(
      0,
      last.heapBytes - first.heapBytes,
    );
    metrics["post-gc/dom-growth-nodes"] = Math.max(
      0,
      last.domNodes - first.domNodes,
    );
  }
  return metrics;
}

export function budgetCompatibility(
  a: EditorProfileReport,
  b: EditorProfileReport,
  sameBuild = false,
) {
  const reasons = [
    ...compatibilityReasons(a, b),
    ...metricReasons(a),
    ...metricReasons(b),
  ];
  if (
    !Object.keys(primaryMetrics(a)).length ||
    !Object.keys(primaryMetrics(b)).length
  )
    reasons.push("no primary measurements");
  for (const report of [a, b]) {
    if (
      JSON.stringify(report.protocol.framePercentiles) !==
      JSON.stringify(FRAME_PERCENTILE_POLICY)
    )
      reasons.push("unknown frame percentile applicability");
    if (report.environment.dirty) reasons.push("dirty source is validity-only");
    if (
      report.environment.build.status !== "measured" ||
      report.environment.build.value.mode !== "production" ||
      report.environment.build.value.e2eHooks
    )
      reasons.push("requires a production build without E2E hooks");
  }
  if (
    sameBuild &&
    (a.environment.revision !== b.environment.revision ||
      JSON.stringify(a.environment.build) !==
        JSON.stringify(b.environment.build))
  )
    reasons.push("baseline/holdout source or assets differ");
  if (
    JSON.stringify(Object.keys(primaryMetrics(a))) !==
    JSON.stringify(Object.keys(primaryMetrics(b)))
  )
    reasons.push("available metrics differ");
  return [...new Set(reasons)];
}

export function independenceReasons(
  runs: { file: string; report: EditorProfileReport }[],
): string[] {
  const reasons: string[] = [],
    ids = new Set<string>(),
    paths = new Set<string>();
  for (const { file, report } of runs) {
    if (!report.execution?.id || !report.execution.startedAt)
      reasons.push(`${file}: execution provenance missing`);
    else {
      if (!Number.isFinite(Date.parse(report.execution.startedAt)))
        reasons.push(`${file}: invalid execution start time`);
      if (ids.has(report.execution.id))
        reasons.push(
          `${file}: duplicate execution identity; copied reports are not independent`,
        );
      ids.add(report.execution.id);
    }
    if (paths.has(file)) reasons.push(`${file}: duplicate report path`);
    paths.add(file);
  }
  return reasons;
}

export type ProfileEvidence = {
  file: string;
  sha256: string;
  report: EditorProfileReport;
};
export type ReportReference = {
  file: string;
  sha256: string;
  executionId: string;
};
export type FrozenDiagnosticBudget = {
  schemaVersion: 1;
  kind: "editor-local-diagnostic-budget";
  createdAt: string;
  status: "validated" | "unstable-baseline" | "invalid";
  errors: string[];
  groups: {
    key: string;
    baseline: ReportReference[];
    holdout: ReportReference[];
    metrics: {
      key: string;
      baseline: number[];
      maximum: number;
      adjacentVariation: number;
      limit: number;
      holdout: readonly number[];
      stable: boolean;
      method: string;
    }[];
  }[];
};
export const profileGroup = (report: EditorProfileReport) =>
  `${report.fixture.preset}/${report.protocol.scenario ?? "editor-response-v1"}`;
export function metricReasons(report: EditorProfileReport): string[] {
  const reasons = Object.entries(primaryMetrics(report))
    .filter(
      ([, value]) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
    .map(([key]) => `invalid primary metric: ${key}`);
  for (const sample of report.samples) {
    if (sample.phase === "diagnostic") continue;
    if (
      (FRAME_PERCENTILE_POLICY.workloadIds as readonly string[]).includes(
        sample.id,
      ) &&
      (sample.frames.status !== "measured" ||
        sample.frames.value.capped !== false ||
        typeof sample.frames.value.statistics.count !== "number" ||
        !Number.isInteger(sample.frames.value.statistics.count) ||
        sample.frames.value.statistics.count <
          FRAME_PERCENTILE_POLICY.minimumIntervals ||
        sample.frames.value.statistics.p95Ms === null)
    )
      reasons.push(`required frame percentile unavailable: ${sample.id}`);
    for (const [name, counter] of Object.entries(sample.cdp))
      if (
        counter.status === "measured" &&
        (typeof counter.value !== "number" ||
          !Number.isFinite(counter.value) ||
          counter.value < 0)
      )
        reasons.push(`invalid measured counter: ${sample.id}/${name}`);
  }
  for (const checkpoint of report.memory)
    if (
      ![checkpoint.heapBytes, checkpoint.domNodes].every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      reasons.push(`invalid memory checkpoint: ${checkpoint.label}`);
  return reasons;
}
function reference(evidence: ProfileEvidence): ReportReference {
  return {
    file: evidence.file,
    sha256: evidence.sha256,
    executionId: evidence.report.execution.id,
  };
}
export function freezeDiagnosticBudget(
  baseline: ProfileEvidence[],
  holdout: ProfileEvidence[],
): FrozenDiagnosticBudget {
  const errors = independenceReasons([...baseline, ...holdout]);
  const keys = [
    ...new Set(baseline.map(({ report }) => profileGroup(report))),
  ].sort();
  if (!keys.length) errors.push("no baseline reports");
  for (const evidence of [...baseline, ...holdout]) {
    for (const reason of metricReasons(evidence.report))
      errors.push(`${evidence.file}: ${reason}`);
    if (!Number.isFinite(Date.parse(evidence.report.execution.startedAt)))
      errors.push(`${evidence.file}: invalid execution start time`);
  }
  for (const evidence of holdout)
    if (!keys.includes(profileGroup(evidence.report)))
      errors.push(`${evidence.file}: unexpected holdout workload`);
  const groups = keys.map((key) => {
    const runs = baseline
      .filter(({ report }) => profileGroup(report) === key)
      .sort(
        (a, b) =>
          Date.parse(a.report.execution.startedAt) -
          Date.parse(b.report.execution.startedAt),
      );
    const check = holdout.filter(({ report }) => profileGroup(report) === key);
    if (runs.length < 5 || !check.length)
      errors.push(
        `${key}: need five baseline repetitions and an independent holdout`,
      );
    if (
      new Set(runs.map(({ report }) => report.execution.startedAt)).size !==
      runs.length
    )
      errors.push(`${key}: ambiguous baseline execution ordering`);
    const first = runs[0]!.report;
    for (const evidence of [...runs, ...check])
      for (const reason of budgetCompatibility(first, evidence.report, true))
        errors.push(`${evidence.file}: ${reason}`);
    const metrics = errors.length
      ? []
      : Object.keys(primaryMetrics(first)).map((metric) => {
          const baselineValues = runs.map(
            ({ report }) => primaryMetrics(report)[metric]!,
          );
          return {
            key: metric,
            baseline: baselineValues,
            ...diagnosticEnvelope(
              baselineValues,
              check.map(({ report }) => primaryMetrics(report)[metric]!),
            ),
          };
        });
    return {
      key,
      baseline: runs.map(reference),
      holdout: check.map(reference),
      metrics,
    };
  });
  return {
    schemaVersion: 1,
    kind: "editor-local-diagnostic-budget",
    createdAt: new Date().toISOString(),
    status: errors.length
      ? "invalid"
      : groups.some((group) => group.metrics.some((metric) => !metric.stable))
        ? "unstable-baseline"
        : "validated",
    errors,
    groups,
  };
}
export function applyDiagnosticBudget(
  budget: FrozenDiagnosticBudget,
  original: ProfileEvidence[],
  candidates: ProfileEvidence[],
) {
  const errors = independenceReasons([...original, ...candidates]);
  if (
    !Array.isArray(budget.groups) ||
    budget.groups.some(
      (group) =>
        !group ||
        !Array.isArray(group.baseline) ||
        !Array.isArray(group.holdout) ||
        !Array.isArray(group.metrics) ||
        [...group.baseline, ...group.holdout, ...group.metrics].some(
          (entry) => !entry || typeof entry !== "object",
        ),
    )
  )
    return {
      schemaVersion: 1,
      status: "invalid",
      errors: [...errors, "invalid frozen budget shape"],
      groups: [],
    };
  if (
    budget.schemaVersion !== 1 ||
    budget.kind !== "editor-local-diagnostic-budget" ||
    budget.status !== "validated"
  )
    errors.push("budget is not validated");
  if (!budget.groups.length) errors.push("budget has no workload groups");
  if (!candidates.length) errors.push("no candidate reports");
  const groupKeys = new Set<string>();
  const referenceFiles = new Set<string>();
  const referenceIds = new Set<string>();
  for (const group of budget.groups) {
    if (typeof group.key !== "string" || !group.key || groupKeys.has(group.key))
      errors.push("invalid or duplicate frozen workload group");
    groupKeys.add(group.key);
    if (group.baseline.length < 5 || !group.holdout.length)
      errors.push(
        `${group.key}: frozen budget requires five baseline references and an independent holdout`,
      );
    const metricKeys = new Set<string>();
    for (const metric of group.metrics) {
      if (
        typeof metric.key !== "string" ||
        !metric.key ||
        metricKeys.has(metric.key)
      )
        errors.push(`${group.key}: invalid or duplicate frozen metric`);
      metricKeys.add(metric.key);
    }
    for (const ref of [...group.baseline, ...group.holdout]) {
      if (
        ![ref.file, ref.sha256, ref.executionId].every(
          (value) => typeof value === "string" && value.length > 0,
        ) ||
        referenceFiles.has(ref.file) ||
        referenceIds.has(ref.executionId)
      )
        errors.push(
          `${group.key}: invalid or duplicate frozen report reference`,
        );
      referenceFiles.add(ref.file);
      referenceIds.add(ref.executionId);
    }
  }
  for (const group of budget.groups)
    for (const ref of [...group.baseline, ...group.holdout]) {
      const actual = original.find((entry) => entry.file === ref.file);
      if (
        !actual ||
        actual.sha256 !== ref.sha256 ||
        actual.report.execution.id !== ref.executionId
      )
        errors.push(`${ref.file}: frozen report identity/content changed`);
    }
  for (const evidence of candidates)
    for (const reason of metricReasons(evidence.report))
      errors.push(`${evidence.file}: ${reason}`);
  for (const evidence of candidates)
    if (
      !budget.groups.some(
        (group) => group.key === profileGroup(evidence.report),
      )
    )
      errors.push(`${evidence.file}: unexpected candidate workload`);
  const groups = budget.groups.map((group) => {
    const baseline = original.find(
      (entry) => entry.file === group.baseline[0]?.file,
    );
    const next = candidates.filter(
      ({ report }) => profileGroup(report) === group.key,
    );
    if (!baseline) errors.push(`${group.key}: frozen baseline report missing`);
    const baselineStarts = group.baseline.map((ref) =>
      Date.parse(
        original.find((entry) => entry.file === ref.file)?.report.execution
          .startedAt ?? "",
      ),
    );
    if (
      baselineStarts.some(
        (start, index) =>
          !Number.isFinite(start) ||
          (index > 0 && start <= baselineStarts[index - 1]!),
      )
    )
      errors.push(`${group.key}: frozen baseline ordering changed`);
    if (
      baseline &&
      JSON.stringify(group.metrics.map((metric) => metric.key).sort()) !==
        JSON.stringify(Object.keys(primaryMetrics(baseline.report)).sort())
    )
      errors.push(
        `${group.key}: frozen metric definitions differ from original report`,
      );
    for (const metric of group.metrics) {
      const baselineValues = group.baseline.map((ref) => {
        const entry = original.find((evidence) => evidence.file === ref.file);
        return entry ? primaryMetrics(entry.report)[metric.key] : undefined;
      });
      const holdoutValues = group.holdout.map((ref) => {
        const entry = original.find((evidence) => evidence.file === ref.file);
        return entry ? primaryMetrics(entry.report)[metric.key] : undefined;
      });
      if (
        JSON.stringify(metric.baseline) !== JSON.stringify(baselineValues) ||
        JSON.stringify(metric.holdout) !== JSON.stringify(holdoutValues)
      )
        errors.push(
          `${group.key}: frozen metric values differ from original reports: ${metric.key}`,
        );
      try {
        const derivation = diagnosticEnvelope(
          baselineValues as number[],
          holdoutValues as number[],
        );
        if (
          metric.maximum !== derivation.maximum ||
          metric.adjacentVariation !== derivation.adjacentVariation ||
          metric.limit !== derivation.limit ||
          metric.stable !== derivation.stable ||
          metric.method !== derivation.method
        )
          errors.push(`${group.key}: frozen derivation changed: ${metric.key}`);
      } catch {
        errors.push(
          `${group.key}: frozen derivation unavailable: ${metric.key}`,
        );
      }
    }
    if (!next.length) errors.push(`${group.key}: missing candidate workload`);
    if (baseline) {
      for (const ref of [...group.baseline, ...group.holdout]) {
        const entry = original.find((evidence) => evidence.file === ref.file);
        if (entry)
          for (const reason of budgetCompatibility(
            baseline.report,
            entry.report,
            true,
          ))
            errors.push(`${entry.file}: frozen original ${reason}`);
      }
      for (const evidence of next)
        for (const reason of budgetCompatibility(
          baseline.report,
          evidence.report,
        ))
          errors.push(`${evidence.file}: ${reason}`);
    }
    if (
      !group.metrics.length ||
      group.metrics.some(
        (metric) =>
          metric.stable !== true ||
          typeof metric.limit !== "number" ||
          !Number.isFinite(metric.limit) ||
          metric.limit < 0,
      )
    )
      errors.push(`${group.key}: invalid frozen limits`);
    const observations = next.flatMap((evidence) =>
      group.metrics.map((metric) => {
        const value = primaryMetrics(evidence.report)[metric.key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          errors.push(
            `${evidence.file}: missing/invalid frozen metric ${metric.key}`,
          );
        return {
          file: evidence.file,
          executionId: evidence.report.execution.id,
          metric: metric.key,
          value,
          limit: metric.limit,
          exceeds: typeof value === "number" && value > metric.limit,
        };
      }),
    );
    return { key: group.key, observations };
  });
  return {
    schemaVersion: 1,
    status: errors.length
      ? "invalid"
      : groups.some((group) =>
            group.observations.some((entry) => entry.exceeds),
          )
        ? "diagnostic-exceeded"
        : "within-local-envelope",
    errors,
    groups,
  };
}
