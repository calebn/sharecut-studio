import { createHash } from "node:crypto";
import path from "node:path";

export type Measurement<T> =
  | { status: "measured"; value: T; method: string }
  | { status: "unavailable"; reason: string };
export type WorkloadObservation =
  | { kind: "load"; detailLoaded: true; firstClipId: string }
  | { kind: "scroll"; before: number; after: number; trustedEvents: number }
  | { kind: "seek"; beforeSeconds: number; afterSeconds: number }
  | { kind: "zoom"; beforeScale: number; afterScale: number }
  | {
      kind: "progress";
      scheduled: number;
      delivered: number;
      rendered: number;
      cadenceMs: number;
      payloadHash: string;
    }
  | { kind: "existing"; contract: string };
export type WorkloadResult =
  | { status: "completed"; observation: WorkloadObservation }
  | { status: "failed"; reason: string }
  | { status: "not-run"; reason: string };
export type WorkloadDefinition = {
  id: string;
  phase: "first-load" | "warm" | "sustained" | "diagnostic";
  input: string;
  iteration?: number;
};
export type FrameWindow = {
  intervalsMs: number[];
  capped: boolean;
  longTaskDurationsMs: number[];
  longTasksSupported: boolean;
};
export type WorkloadSample = WorkloadDefinition & {
  iteration: number;
  result: WorkloadResult;
  driverWallMs: number;
  frames: Measurement<
    FrameWindow & { statistics: ReturnType<typeof statistics> }
  >;
  longTasks: Measurement<{ count: number; totalMs: number; maximumMs: number }>;
  cdp: Record<string, Measurement<number>>;
  rawCounters: {
    before: Measurement<Record<string, number>>;
    after: Measurement<Record<string, number>>;
  };
};
type FixtureProject = {
  meta: Record<string, unknown> & {
    name: string;
    created_at?: string;
    workspace_dir?: string;
  };
  timeline: { duration_sec: number; tracks: unknown[]; clips: unknown[] };
  transcripts: {
    combined?: { utterances: unknown[] } | null;
    per_track?: { words: unknown[] }[];
  };
  history?: {
    entries: (Record<string, unknown> & {
      created_at?: string;
      snapshot_file?: string;
    })[];
  };
};
export type EditorProfileReport = {
  schemaVersion: 1;
  measurementVersion: "editor-response-v1";
  status: "complete" | "incomplete";
  fixture: ReturnType<typeof fixtureIdentity>;
  environment: {
    revision: string;
    dirty: boolean;
    node: string;
    host: {
      hostname: string;
      os: string;
      architecture: string;
      cpuModel: string | null;
      logicalCpus: number;
      memoryBytes: number;
    };
    browser: string;
    viewport: { width: number; height: number } | null;
    headless: unknown;
    page: Measurement<{
      theme: string | null;
      reducedMotion: boolean;
      deviceScale: number;
      hardwareConcurrency: number;
    }>;
    build: Measurement<{
      mode: "production" | "development" | "unknown";
      assets: { path: string; sha256: string }[];
      e2eHooks: boolean;
    }>;
    playwrightTrace: unknown;
    chromeTrace: "separate-diagnostic-window";
    cache: "fresh-context; prebuilt-waveforms; OS/server caches uncontrolled";
    gc: "forced after frame windows and each endurance round";
  };
  protocol: {
    scrubRounds: number;
    arrowPressesPerRound: number;
    warmupActions: 0;
    retries: number;
    repeatIndex: number;
    frameLimit: 10000;
  };
  samples: WorkloadSample[];
  memory: {
    label: string;
    elapsedMs: number;
    gcMs: number;
    domNodes: number;
    heapBytes: number;
  }[];
  coverage: { id: string; result: WorkloadResult }[];
  artifacts: string[];
  errors: string[];
  legacyEnduranceWallMs?: number;
};

export const measured = <T>(value: T, method: string): Measurement<T> => ({
  status: "measured",
  value,
  method,
});
export const unavailable = (reason: string): Measurement<never> => ({
  status: "unavailable",
  reason,
});
export function statistics(values: readonly number[]) {
  if (!values.length)
    return { count: 0, medianMs: null, p95Ms: null, maximumMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    medianMs:
      sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    maximumMs: sorted.at(-1)!,
  };
}
export function counterDeltas(
  before: Measurement<Record<string, number>>,
  after: Measurement<Record<string, number>>,
) {
  return Object.fromEntries(
    [
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
    ].map((name) => {
      if (before.status === "unavailable" || after.status === "unavailable")
        return [
          name,
          unavailable(
            before.status === "unavailable"
              ? before.reason
              : after.status === "unavailable"
                ? after.reason
                : "snapshot unavailable",
          ),
        ];
      const a = before.value[name];
      const b = after.value[name];
      return [
        name,
        Number.isFinite(a) && Number.isFinite(b) && b! >= a!
          ? measured(
              (b! - a!) * 1000,
              `CDP Performance.${name} seconds delta converted to ms; overlapping categories`,
            )
          : unavailable(`${name} missing or reset across window`),
      ];
    }),
  );
}
export function fixtureIdentity(raw: string, projectPath: string) {
  const project = JSON.parse(raw) as FixtureProject;
  const root = path.dirname(projectPath);
  const canonical = {
    ...project,
    meta: { ...project.meta, created_at: "<generated>", workspace_dir: "." },
    ...(project.history
      ? {
          history: {
            ...project.history,
            entries: project.history.entries.map((entry) => ({
              ...entry,
              created_at: "<generated>",
              snapshot_file:
                entry.snapshot_file && path.isAbsolute(entry.snapshot_file)
                  ? path.relative(root, entry.snapshot_file)
                  : entry.snapshot_file,
            })),
          },
        }
      : {}),
  };
  const counts = {
    durationSec: project.timeline.duration_sec,
    tracks: project.timeline.tracks.length,
    clips: project.timeline.clips.length,
    utterances: project.transcripts.combined?.utterances.length ?? 0,
    words:
      project.transcripts.per_track?.reduce((n, t) => n + t.words.length, 0) ??
      0,
    historyEntries: project.history?.entries.length ?? 0,
  };
  const preset =
    counts.durationSec === 120 &&
    counts.clips === 24 &&
    counts.utterances === 200 &&
    counts.tracks === 2 &&
    counts.historyEntries === 40
      ? "small"
      : counts.durationSec === 7200 &&
          counts.clips === 1200 &&
          counts.utterances === 10000 &&
          counts.tracks === 2 &&
          counts.historyEntries === 400
        ? "large"
        : "custom";
  return {
    canonicalVersion: "fixture-v1",
    canonicalSha256: hash(JSON.stringify(canonical)),
    rawSha256: hash(raw),
    counts,
    preset,
    waveform: "prebuilt; sparse silent media; mode not encoded in project",
  };
}
export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function compatibilityReasons(
  a: EditorProfileReport,
  b: EditorProfileReport,
): string[] {
  const reasons: string[] = [];
  const equal = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y))
      reasons.push(`${label} differs`);
  };
  if (a.status !== "complete" || b.status !== "complete")
    reasons.push("incomplete report");
  equal("measurement definition", a.measurementVersion, b.measurementVersion);
  equal("fixture", a.fixture.canonicalSha256, b.fixture.canonicalSha256);
  const { repeatIndex: _a, ...aProtocol } = a.protocol;
  const { repeatIndex: _b, ...bProtocol } = b.protocol;
  equal("protocol", aProtocol, bProtocol);
  for (const key of [
    "host",
    "browser",
    "viewport",
    "headless",
    "page",
    "playwrightTrace",
    "chromeTrace",
    "cache",
    "gc",
  ] as const)
    equal(key, a.environment[key], b.environment[key]);
  if (!a.environment.host.cpuModel || !b.environment.host.cpuModel)
    reasons.push("unknown machine compatibility");
  for (const report of [a, b]) {
    if (
      report.environment.build.status === "unavailable" ||
      report.environment.build.value.mode === "unknown" ||
      report.environment.page.status === "unavailable"
    )
      reasons.push("unknown served build or page environment");
    if (
      typeof report.environment.headless !== "boolean" ||
      report.environment.browser === "unknown" ||
      (report.environment.page.status === "measured" &&
        !["light", "dark"].includes(report.environment.page.value.theme ?? ""))
    )
      reasons.push("unknown browser/headless/theme provenance");
    if (report.samples.some((sample) => sample.result.status !== "completed"))
      reasons.push("failed sample");
  }
  if (
    a.environment.build.status === "measured" &&
    b.environment.build.status === "measured"
  ) {
    equal(
      "build mode",
      a.environment.build.value.mode,
      b.environment.build.value.mode,
    );
    equal(
      "E2E hooks",
      a.environment.build.value.e2eHooks,
      b.environment.build.value.e2eHooks,
    );
  }
  equal(
    "workload definitions",
    a.samples.map(({ id, iteration, phase, input }) => ({
      id,
      iteration,
      phase,
      input,
    })),
    b.samples.map(({ id, iteration, phase, input }) => ({
      id,
      iteration,
      phase,
      input,
    })),
  );
  return [...new Set(reasons)];
}
