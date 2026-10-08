export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type DurableState = {
  clips: {
    id: string;
    track_id: string;
    source_start: number;
    source_end: number;
    timeline_start: number;
    source_id: string | null;
    fade_in_ms: number;
    fade_out_ms: number;
    join_in_mode: string;
    mute_regions: Json[];
  }[];
  tracks: { id: string; fader_db: number; gain_db: number; muted: boolean }[];
  envelopes: {
    track_id: string;
    parameter: string;
    points: { id: string; time: number; value: number }[];
  }[];
  comments: {
    id: string;
    body: string;
    author: string;
    timeline_start: number;
    timeline_end: number | null;
    track_ids: string[];
    resolved: boolean;
  }[];
};
export function parseDurableState(input: unknown): DurableState {
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected durable object");
    return value as Record<string, unknown>;
  };
  const rows = (value: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(value)) throw new Error("Expected durable collection");
    return value.map(object);
  };
  const finite = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value);
  const state = object(input);
  for (const clip of rows(state.clips)) {
    if (
      !["id", "track_id", "join_in_mode"].every(
        (key) => typeof clip[key] === "string",
      ) ||
      ![
        "source_start",
        "source_end",
        "timeline_start",
        "fade_in_ms",
        "fade_out_ms",
      ].every((key) => finite(clip[key])) ||
      !(clip.source_id === null || typeof clip.source_id === "string") ||
      !Array.isArray(clip.mute_regions)
    )
      throw new Error("Invalid durable clip geometry");
  }
  for (const track of rows(state.tracks))
    if (
      typeof track.id !== "string" ||
      !finite(track.fader_db) ||
      !finite(track.gain_db) ||
      typeof track.muted !== "boolean"
    )
      throw new Error("Invalid durable track mix");
  for (const envelope of rows(state.envelopes)) {
    if (
      typeof envelope.track_id !== "string" ||
      typeof envelope.parameter !== "string"
    )
      throw new Error("Invalid durable envelope");
    for (const point of rows(envelope.points))
      if (
        typeof point.id !== "string" ||
        !finite(point.time) ||
        !finite(point.value)
      )
        throw new Error("Invalid durable envelope point");
  }
  for (const comment of rows(state.comments))
    if (
      !["id", "body", "author"].every(
        (key) => typeof comment[key] === "string",
      ) ||
      !finite(comment.timeline_start) ||
      !(comment.timeline_end === null || finite(comment.timeline_end)) ||
      typeof comment.resolved !== "boolean" ||
      !Array.isArray(comment.track_ids) ||
      !comment.track_ids.every((id) => typeof id === "string")
    )
      throw new Error("Invalid durable comment");
  return input as DurableState;
}
export type Phase = "setup" | "action" | "cancel" | "undo";
export type JournalEvent = { seq: number; phase: Phase } & (
  | {
      kind: "activation";
      label: string;
      verb: string;
      outcome: "started" | "completed" | "failed";
      error?: string;
    }
  | { kind: "request"; requestId: number; type: string; body: string }
  | { kind: "response"; requestId: number; status: number; body: string }
  | { kind: "read-request"; requestId: number; url: string; method: string }
  | { kind: "read-response"; requestId: number; status: number; body: string }
  | { kind: "read-failed"; requestId: number; error: string }
  | { kind: "error"; message: string }
);
export type TaskRoute =
  | {
      id: string;
      input: "pointer" | "keyboard" | "numeric" | "cdp-touch";
      command: string | null;
      mutations: number;
      cancel: boolean;
      undo: "history" | "comment-toast" | "none";
    }
  | { id: string; pending: string };
export type TaskDefinition = {
  id: string;
  family: string;
  viewport: { width: number; height: number };
  start: DurableState;
  expected: DurableState;
  routes: TaskRoute[];
  tolerances: Record<string, number>;
  editMode?: "ripple";
  seek?: number;
};
export type EditingTrial = {
  task: string;
  route: string;
  mode: "validity-only" | "baseline" | "diagnostic";
  journal: JournalEvent[];
  before?: DurableState;
  after?: DurableState;
  canceled?: DurableState;
  undone?: DurableState;
  transport?: { seconds: number; playing: boolean };
  durationMs?: number;
  errors?: string[];
  profiler?: string;
  protocolHash?: string;
  definitionHash?: string;
  role?: "host";
  fixture?: {
    projectPath: string;
    savedHash: string;
    media: Record<string, string>;
  };
  artifacts?: string[];
  uiEvidence?: {
    stage: string;
    phase: Phase;
    geometry: Json;
    screenshot?: string;
  }[];
  cancellations?: { probe: string; state: DurableState }[];
  history?: {
    before: HistoryIdentity | null;
    after: HistoryIdentity | null;
    undone: HistoryIdentity | null;
  };
};
export type HistoryIdentity = {
  cursor: number;
  headId: string | null;
  entries: { id: string; label: string; operation: string | null }[];
};
export type ObservationStatus =
  | "pass"
  | "fail"
  | "not-run"
  | "pending"
  | "not-applicable";
export type TrialAssessment = {
  observations: {
    save: ObservationStatus;
    cancel: ObservationStatus;
    undo: ObservationStatus;
  };
  status: "pass" | "fail" | "pending";
  reasons: string[];
  activations: Record<Phase, number>;
  mutations: number;
  accidentalCommands: number;
  completedWork: number;
  canceledReads: number;
};

function differences(
  expected: Json,
  actual: Json | undefined,
  path: string,
  tolerance: Record<string, number>,
): string[] {
  if (
    typeof expected === "number" &&
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(expected - actual) <= (tolerance[path] ?? 0)
  )
    return [];
  if (expected === actual) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      return [
        `${path} expected ${expected.length} items, observed ${actual.length}`,
      ];
    return expected.flatMap((value, index) =>
      differences(value, actual[index], `${path}.${index}`, tolerance),
    );
  }
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual)
  ) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) =>
      differences(expected[key], actual[key], `${path}.${key}`, tolerance),
    );
  }
  return [
    `${path} expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`,
  ];
}
export function savedStateDifferences(
  expected: DurableState,
  actual: DurableState,
  prefix = "after",
  tolerances: Record<string, number> = {},
): string[] {
  for (const [label, state] of [
    ["expected", expected],
    ["observed", actual],
  ] as const)
    if (new Set(state.clips.map((clip) => clip.id)).size !== state.clips.length)
      return [`${prefix} ${label} clip IDs are not unique`];
  const identityState = (state: DurableState) => ({
    ...state,
    clips: Object.fromEntries(state.clips.map((clip) => [clip.id, clip])),
  });
  return differences(
    identityState(expected),
    identityState(actual),
    prefix,
    tolerances,
  );
}
export function assessEditingTrial(
  definition: TaskDefinition,
  trial: EditingTrial,
): TrialAssessment {
  const reasons: string[] = [...(trial.errors ?? [])];
  const activations = { setup: 0, action: 0, cancel: 0, undo: 0 };
  const route = definition.routes.find((item) => item.id === trial.route);
  if (!route || "pending" in route)
    return {
      status: route && "pending" in route ? "pending" : "fail",
      reasons: [route && "pending" in route ? route.pending : "unknown route"],
      activations,
      mutations: 0,
      accidentalCommands: 0,
      completedWork: 0,
      canceledReads: 0,
      observations: {
        save: route && "pending" in route ? "pending" : "not-run",
        cancel: route && "pending" in route ? "pending" : "not-run",
        undo: route && "pending" in route ? "pending" : "not-run",
      },
    };
  let previous = 0;
  let mutations = 0;
  let accidentalCommands = 0;
  let canceledReads = 0;
  for (const event of trial.journal) {
    if (event.seq <= previous)
      reasons.push("journal sequence is not increasing");
    previous = event.seq;
    if (event.kind === "activation") {
      activations[event.phase]++;
      if (event.outcome !== "completed")
        reasons.push(`activation ${event.label} ${event.outcome}`);
    }
    if (event.kind === "error") reasons.push(event.message);
    if (event.kind === "read-failed") {
      const read = trial.journal.find(
        (row) =>
          row.kind === "read-request" && row.requestId === event.requestId,
      );
      let replaced = false;
      if (read?.kind === "read-request") {
        const url = new URL(read.url);
        const eligible =
          read.phase === "setup" &&
          event.phase === "setup" &&
          read.method === "GET" &&
          url.pathname === "/api/document/state" &&
          url.searchParams.get("phase") === "detail" &&
          Boolean(url.searchParams.get("path")) &&
          event.error === "net::ERR_ABORTED";
        replaced =
          eligible &&
          trial.journal.some((candidate) => {
            if (
              candidate.kind !== "read-request" ||
              candidate.phase !== "setup" ||
              candidate.seq <= read.seq ||
              candidate.requestId === read.requestId ||
              candidate.url !== read.url ||
              candidate.method !== "GET"
            )
              return false;
            const outcomes = trial.journal.filter(
              (response) =>
                response.kind === "read-response" &&
                response.requestId === candidate.requestId,
            );
            return (
              outcomes.length === 1 &&
              outcomes.some((response) => {
                if (
                  response.kind !== "read-response" ||
                  response.phase !== "setup" ||
                  response.requestId !== candidate.requestId ||
                  response.seq <= candidate.seq ||
                  response.seq <= event.seq ||
                  response.status < 200 ||
                  response.status >= 300
                )
                  return false;
                try {
                  const body = JSON.parse(response.body) as Record<
                    string,
                    unknown
                  >;
                  return (
                    Number.isSafeInteger(body.server_seq) &&
                    Number(body.server_seq) >= 0 &&
                    typeof body.state_token === "string" &&
                    /^[a-f0-9]{64}$/.test(body.state_token)
                  );
                } catch {
                  return false;
                }
              })
            );
          });
      }
      if (replaced) canceledReads++;
      else
        reasons.push(
          `read ${event.requestId} failed ${event.error} without admitted replacement`,
        );
    }
    if (event.kind === "read-response" && event.status >= 400)
      reasons.push(`read ${event.requestId} failed HTTP ${event.status}`);
    if (event.kind !== "request") continue;
    const responses = trial.journal.filter(
      (item) => item.kind === "response" && item.requestId === event.requestId,
    );
    if (responses.length !== 1)
      reasons.push(
        `request ${event.requestId} has ${responses.length ? "multiple responses" : "no response"}`,
      );
    const response = responses[0];
    if (response?.kind === "response") {
      if (response.seq <= event.seq || response.phase !== event.phase)
        reasons.push(
          `request ${event.requestId} response order or phase differs`,
        );
      try {
        const body = JSON.parse(response.body) as Record<string, unknown>;
        if (body.ok !== true || body.type !== "Applied")
          reasons.push(`request ${event.requestId} has unknown outcome`);
      } catch {
        reasons.push(`request ${event.requestId} has invalid response JSON`);
      }
    }
    if (
      response?.kind === "response" &&
      (response.status < 200 || response.status >= 300)
    )
      reasons.push(`request ${event.requestId} failed ${response.status}`);
    if (event.phase === "cancel") {
      accidentalCommands++;
      reasons.push(`cancellation command ${event.type}`);
    }
    if (event.phase === "action") {
      if (event.type !== route.command) {
        accidentalCommands++;
        reasons.push(`unexpected action command ${event.type}`);
      }
      if (
        response?.kind === "response" &&
        response.status >= 200 &&
        response.status < 300
      )
        mutations++;
    }
  }
  if (mutations !== route.mutations)
    reasons.push(
      `action expected ${route.mutations} mutations, observed ${mutations}`,
    );
  if (mutations > route.mutations)
    accidentalCommands += mutations - route.mutations;
  if (!trial.before) reasons.push("starting state not observed");
  else
    reasons.push(
      ...savedStateDifferences(definition.start, trial.before, "before"),
    );
  if (!trial.after) reasons.push("saved result not observed");
  else {
    reasons.push(
      ...savedStateDifferences(
        definition.expected,
        trial.after,
        "after",
        route.input === "pointer" || route.input === "cdp-touch"
          ? definition.tolerances
          : Object.fromEntries(
              Object.keys(definition.tolerances).map((key) => [key, 1e-6]),
            ),
      ),
    );
    if (
      definition.seek === undefined &&
      savedStateDifferences(definition.start, trial.after).length === 0
    )
      reasons.push("task made no saved change");
  }
  if (definition.seek !== undefined) {
    if (!trial.transport) reasons.push("transport not observed");
    else {
      if (trial.transport.playing) reasons.push("seek started playback");
      if (!Number.isFinite(trial.transport.seconds))
        reasons.push("seek position is not finite");
      else if (Math.abs(trial.transport.seconds - definition.seek) > 0.03)
        reasons.push(
          `seek expected ${definition.seek}, observed ${trial.transport.seconds}`,
        );
    }
  }
  if (activations.action === 0) reasons.push("task input not observed");
  if (route.cancel && activations.cancel === 0)
    reasons.push("cancel input not observed");
  if (route.undo !== "none" && activations.undo === 0)
    reasons.push("Undo input not observed");
  const undoRequests = trial.journal.filter(
    (event) => event.kind === "request" && event.phase === "undo",
  );
  if (route.undo !== "none") {
    const expectedUndo =
      route.undo === "comment-toast" ? "ResolveComment" : "UndoHistory";
    if (
      undoRequests.length !== route.mutations ||
      undoRequests.some(
        (event) => event.kind === "request" && event.type !== expectedUndo,
      )
    )
      reasons.push(
        `Undo expected ${route.mutations} ${expectedUndo} commands, observed ${undoRequests.length}`,
      );
  }
  if (route.cancel) {
    for (const cancellation of trial.cancellations ?? [])
      reasons.push(
        ...savedStateDifferences(
          definition.start,
          cancellation.state,
          `canceled-${cancellation.probe}`,
        ),
      );
    if (!trial.canceled) reasons.push("cancellation not run");
    else
      reasons.push(
        ...savedStateDifferences(definition.start, trial.canceled, "canceled"),
      );
  }
  if (route.undo !== "none") {
    if (!trial.undone) reasons.push("Undo not run");
    else
      reasons.push(
        ...savedStateDifferences(definition.start, trial.undone, "undone"),
      );
  }
  return {
    status: reasons.length ? "fail" : "pass",
    reasons,
    activations,
    mutations,
    accidentalCommands,
    completedWork: reasons.length ? 0 : 1,
    canceledReads,
    observations: {
      save: !trial.after ? "not-run" : reasons.length ? "fail" : "pass",
      cancel: !route.cancel
        ? "not-applicable"
        : !trial.canceled
          ? "not-run"
          : activations.cancel === 0 ||
              accidentalCommands > 0 ||
              savedStateDifferences(definition.start, trial.canceled).length >
                0 ||
              (trial.cancellations ?? []).some(
                (row) =>
                  savedStateDifferences(definition.start, row.state).length > 0,
              )
            ? "fail"
            : "pass",
      undo:
        route.undo === "none"
          ? "not-applicable"
          : !trial.undone
            ? "not-run"
            : activations.undo === 0 ||
                undoRequests.length !== route.mutations ||
                savedStateDifferences(definition.start, trial.undone).length > 0
              ? "fail"
              : "pass",
    },
  };
}

export function summarizeEditingAttempts(
  definitions: TaskDefinition[],
  attempts: {
    task: string;
    route: string;
    valid: boolean;
    mode: EditingTrial["mode"];
    durationMs?: number;
  }[],
) {
  return definitions.flatMap((task) =>
    task.routes.map((route) => {
      if ("pending" in route)
        return {
          task: task.id,
          route: route.id,
          status: "pending",
          reason: route.pending,
          attempted: 0,
          valid: 0,
          failed: 0,
          baselineValid: 0,
          duration: null,
        };
      const rows = attempts.filter(
        (attempt) => attempt.task === task.id && attempt.route === route.id,
      );
      const times = rows
        .filter(
          (row) =>
            row.valid &&
            row.mode === "baseline" &&
            row.durationMs !== undefined &&
            Number.isFinite(row.durationMs),
        )
        .map((row) => row.durationMs!)
        .sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      const duration =
        times.length >= 5
          ? {
              medianMs:
                times.length % 2
                  ? times[middle]
                  : (times[middle - 1] + times[middle]) / 2,
              minMs: times[0],
              maxMs: times[times.length - 1],
            }
          : null;
      return {
        task: task.id,
        route: route.id,
        status:
          rows.length === 0
            ? "not-run"
            : rows.every((row) => row.valid)
              ? "pass"
              : "fail",
        reason:
          rows.length === 0
            ? "No attempt retained"
            : times.length < 5
              ? "Fewer than five valid baseline trials"
              : "Timing inconclusive until limiter and noise evidence are admitted",
        attempted: rows.length,
        valid: rows.filter((row) => row.valid).length,
        failed: rows.filter((row) => !row.valid).length,
        baselineValid: times.length,
        duration,
      };
    }),
  );
}
