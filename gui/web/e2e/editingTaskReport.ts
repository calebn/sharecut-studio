export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type DurableState = {
  duration_sec: number;
  stable: Json;
  sources: {
    id: string;
    path: string;
    speaker: string | null;
    label: string | null;
    offset_sec: number;
    duration_sec: number | null;
    sample_rate: number | null;
    channels: number | null;
    clipping_regions: Json[];
    clipping_truncated: boolean;
  }[];
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
  tracks: {
    id: string;
    fader_db: number;
    gain_db: number;
    muted: boolean;
    role: string;
    media: Json;
    invariants: Json;
  }[];
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
    resolved_by: string | null;
    review_version_id: string | null;
    edit_decision_id: string | null;
    timeline_spans: { start: number; end: number }[];
    action_items: {
      id: string;
      text: string;
      done: boolean;
      completed_by: string | null;
    }[];
    replies: { id: string; body: string; author: string }[];
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
  if (!finite(state.duration_sec) || state.stable === undefined)
    throw new Error("Invalid durable extent or stable remainder");
  const sourceIds = new Set<string>();
  for (const source of rows(state.sources)) {
    if (
      !["id", "path"].every((key) => typeof source[key] === "string") ||
      !["speaker", "label"].every(
        (key) => source[key] === null || typeof source[key] === "string",
      ) ||
      !finite(source.offset_sec) ||
      !(source.duration_sec === null || finite(source.duration_sec)) ||
      !(source.sample_rate === null || Number.isInteger(source.sample_rate)) ||
      !(source.channels === null || Number.isInteger(source.channels)) ||
      !Array.isArray(source.clipping_regions) ||
      typeof source.clipping_truncated !== "boolean" ||
      sourceIds.has(source.id as string)
    )
      throw new Error("Invalid or duplicate durable source identity");
    sourceIds.add(source.id as string);
  }
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
    if (clip.source_id !== null && !sourceIds.has(clip.source_id as string))
      throw new Error("Durable clip references a missing source");
  }
  for (const track of rows(state.tracks))
    if (
      typeof track.id !== "string" ||
      !finite(track.fader_db) ||
      !finite(track.gain_db) ||
      typeof track.muted !== "boolean" ||
      typeof track.role !== "string" ||
      track.media === undefined ||
      track.invariants === undefined
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
  for (const comment of rows(state.comments)) {
    if (
      !["id", "body", "author"].every(
        (key) => typeof comment[key] === "string",
      ) ||
      !finite(comment.timeline_start) ||
      !(comment.timeline_end === null || finite(comment.timeline_end)) ||
      typeof comment.resolved !== "boolean" ||
      !Array.isArray(comment.track_ids) ||
      !comment.track_ids.every((id) => typeof id === "string") ||
      !["resolved_by", "review_version_id", "edit_decision_id"].every(
        (key) => comment[key] === null || typeof comment[key] === "string",
      )
    )
      throw new Error("Invalid durable comment");
    for (const span of rows(comment.timeline_spans))
      if (
        !finite(span.start) ||
        !finite(span.end) ||
        (span.start as number) < 0 ||
        (span.end as number) <= (span.start as number)
      )
        throw new Error("Invalid durable comment span");
    for (const item of rows(comment.action_items))
      if (
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        typeof item.done !== "boolean" ||
        !(item.completed_by === null || typeof item.completed_by === "string")
      )
        throw new Error("Invalid durable comment action item");
    for (const reply of rows(comment.replies))
      if (
        !["id", "body", "author"].every((key) => typeof reply[key] === "string")
      )
        throw new Error("Invalid durable comment reply");
  }
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
  | {
      kind: "read-body-failed";
      requestId: number;
      status: number;
      error: string;
    }
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
  historyOperation?: string | null;
  historyLabels?: { before: string; after: string };
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
export function parseEditingJournal(input: unknown): JournalEvent[] {
  if (!Array.isArray(input)) throw new Error("Invalid retained journal");
  const phases = ["setup", "action", "cancel", "undo"];
  const kinds = [
    "activation",
    "request",
    "response",
    "read-request",
    "read-response",
    "read-failed",
    "read-body-failed",
    "error",
  ];
  for (const row of input) {
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      !phases.includes(row.phase) ||
      !kinds.includes(row.kind)
    )
      throw new Error("Invalid retained journal event");
    if (
      row.kind !== "activation" &&
      row.kind !== "error" &&
      (!Number.isSafeInteger(row.requestId) || row.requestId < 1)
    )
      throw new Error("Invalid retained request ID");
    if (
      ["response", "read-response", "read-body-failed"].includes(row.kind) &&
      (!Number.isInteger(row.status) || row.status < 100 || row.status > 599)
    )
      throw new Error("Invalid retained HTTP status");
    const strings =
      row.kind === "activation"
        ? ["label", "verb"]
        : row.kind === "request"
          ? ["type", "body"]
          : row.kind === "read-request"
            ? ["url", "method"]
            : row.kind === "error"
              ? ["message"]
              : row.kind.endsWith("failed")
                ? ["error"]
                : ["body"];
    if (
      !strings.every((key) => typeof row[key] === "string") ||
      (row.kind === "activation" &&
        !["started", "completed", "failed"].includes(row.outcome))
    )
      throw new Error("Invalid retained journal payload");
    if (row.kind === "read-request") new URL(row.url);
  }
  return input as JournalEvent[];
}
function documentStateBody(body: string): boolean {
  try {
    const value = JSON.parse(body);
    return (
      value !== null &&
      typeof value === "object" &&
      Number.isSafeInteger(value.server_seq) &&
      value.server_seq >= 0 &&
      (value.resync === true ||
        (typeof value.state_token === "string" &&
          /^[a-f0-9]{64}$/.test(value.state_token)))
    );
  } catch {
    return false;
  }
}
export function assessEditingTrial(
  definition: TaskDefinition,
  trial: EditingTrial,
): TrialAssessment {
  const reasons: string[] = [...(trial.errors ?? [])];
  if (
    typeof trial.durationMs !== "number" ||
    !Number.isFinite(trial.durationMs) ||
    trial.durationMs < 0
  )
    reasons.push("elapsed duration is missing, non-finite or negative");
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
  try {
    parseEditingJournal(trial.journal);
  } catch (error) {
    return {
      status: "fail",
      reasons: [...reasons, String(error)],
      activations,
      mutations: 0,
      accidentalCommands: 0,
      completedWork: 0,
      canceledReads: 0,
      observations: {
        save: "fail",
        cancel: route.cancel ? "fail" : "not-applicable",
        undo: route.undo === "none" ? "not-applicable" : "fail",
      },
    };
  }
  const requests = trial.journal.filter(
    (row) => row.kind === "request" || row.kind === "read-request",
  );
  const admittedAborts = new Set<number>();
  for (const request of requests) {
    if (request.kind !== "request" && request.kind !== "read-request") continue;
    if (
      requests.filter(
        (row) => "requestId" in row && row.requestId === request.requestId,
      ).length !== 1
    )
      reasons.push(`duplicate request ${request.requestId}`);
    if (request.kind === "read-request") {
      const terminal = trial.journal.filter(
        (row) =>
          (row.kind === "read-response" || row.kind === "read-failed") &&
          row.requestId === request.requestId,
      );
      if (terminal.length !== 1)
        reasons.push(
          `read ${request.requestId} has ${terminal.length} terminal outcomes`,
        );
    }
  }
  for (const outcome of trial.journal) {
    if (
      ![
        "response",
        "read-response",
        "read-failed",
        "read-body-failed",
      ].includes(outcome.kind) ||
      !("requestId" in outcome)
    )
      continue;
    const request = requests.find(
      (row) => "requestId" in row && row.requestId === outcome.requestId,
    );
    if (
      !request ||
      (outcome.kind === "response") !== (request.kind === "request")
    )
      reasons.push(`orphan outcome ${outcome.requestId}`);
    else if (outcome.seq <= request.seq || outcome.phase !== request.phase)
      reasons.push(`outcome ${outcome.requestId} order or phase differs`);
    if (
      outcome.kind === "read-response" &&
      request?.kind === "read-request" &&
      new URL(request.url).pathname === "/api/document/state" &&
      outcome.status >= 200 &&
      outcome.status < 300 &&
      !documentStateBody(outcome.body)
    )
      reasons.push(`read ${outcome.requestId} has invalid document state`);
  }
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
                return (
                  documentStateBody(response.body) &&
                  JSON.parse(response.body).resync !== true
                );
              })
            );
          });
      }
      if (replaced) {
        canceledReads++;
        admittedAborts.add(event.requestId);
      } else
        reasons.push(
          `read ${event.requestId} failed ${event.error} without admitted replacement`,
        );
    }
    if (
      event.kind === "read-response" &&
      (event.status < 200 || event.status >= 300)
    )
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
    if (event.phase === "setup") {
      accidentalCommands++;
      reasons.push(`unexpected setup command ${event.type}`);
    }
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
  for (const event of trial.journal)
    if (event.kind === "read-body-failed") {
      if (
        !admittedAborts.has(event.requestId) ||
        event.status < 200 ||
        event.status >= 300 ||
        !event.error.includes("Network.getResponseBody") ||
        !event.error.includes(
          "No data found for resource with given identifier",
        ) ||
        trial.journal.filter(
          (row) =>
            row.kind === "read-body-failed" &&
            row.requestId === event.requestId,
        ).length !== 1
      )
        reasons.push(`read body ${event.requestId} failed ${event.error}`);
    }
  for (const event of trial.journal)
    if (
      event.kind === "request" &&
      event.phase === "undo" &&
      (route.undo === "none" ||
        event.type !==
          (route.undo === "comment-toast" ? "ResolveComment" : "UndoHistory"))
    ) {
      accidentalCommands++;
      reasons.push(`unexpected Undo command ${event.type}`);
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
      if (trial.transport.playing !== false)
        reasons.push("seek stopped playback state not observed");
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
  const identities = trial.history;
  const validHistory = (
    value: HistoryIdentity | null | undefined,
  ): value is HistoryIdentity =>
    Boolean(
      value &&
        Array.isArray(value.entries) &&
        value.entries.every(
          (row) =>
            row &&
            typeof row.id === "string" &&
            row.id.length > 0 &&
            typeof row.label === "string" &&
            (row.operation === null || typeof row.operation === "string"),
        ) &&
        Number.isSafeInteger(value.cursor) &&
        value.cursor >= -1 &&
        value.cursor < value.entries.length &&
        new Set(value.entries.map((row) => row.id)).size ===
          value.entries.length &&
        value.headId ===
          (value.cursor < 0 ? null : value.entries[value.cursor].id) &&
        (value.cursor !== -1 || value.entries.length === 0),
    );
  if (
    !identities ||
    !validHistory(identities.before) ||
    !validHistory(identities.after) ||
    (route.undo !== "none" && !validHistory(identities.undone))
  )
    reasons.push("History evidence missing or invalid");
  else {
    const before = identities.before,
      after = identities.after;
    const baseline = before.cursor < 0 ? 0 : before.cursor;
    if (route.undo === "history") {
      const preserved = before.entries.slice(0, before.cursor + 1);
      if (
        after.cursor !== baseline + route.mutations ||
        after.entries.length !== baseline + route.mutations + 1 ||
        after.headId === before.headId ||
        JSON.stringify(after.entries.slice(0, preserved.length)) !==
          JSON.stringify(preserved) ||
        after.entries
          .slice(baseline + 1)
          .some(
            (row) =>
              row.operation !== definition.historyOperation ||
              (definition.historyLabels &&
                row.label !== definition.historyLabels.after),
          ) ||
        (before.cursor < 0 &&
          (after.entries[0]?.operation !== null ||
            (definition.historyLabels &&
              after.entries[0]?.label !== definition.historyLabels.before)))
      )
        reasons.push("History action transition differs");
      const undone = identities.undone!;
      if (
        undone.cursor !== baseline ||
        undone.headId !== after.entries[baseline]?.id ||
        JSON.stringify(undone.entries) !== JSON.stringify(after.entries)
      )
        reasons.push("History Undo transition differs");
    } else if (route.undo === "comment-toast") {
      const undone = identities.undone!;
      if (
        after.cursor !== baseline + 1 ||
        after.entries.length !== baseline + 2 ||
        after.entries[baseline + 1]?.label !== "after resolve comment" ||
        after.entries[baseline + 1]?.operation !== null ||
        (before.cursor < 0 &&
          after.entries[0]?.label !== "before resolve comment") ||
        JSON.stringify(after.entries.slice(0, before.cursor + 1)) !==
          JSON.stringify(before.entries.slice(0, before.cursor + 1))
      )
        reasons.push("Comment resolve History transition differs");
      if (
        undone.cursor !== baseline + 2 ||
        undone.entries.length !== baseline + 3 ||
        undone.headId === after.headId ||
        undone.entries[baseline + 2]?.label !== "after unresolve comment" ||
        undone.entries[baseline + 2]?.operation !== null ||
        JSON.stringify(undone.entries.slice(0, after.entries.length)) !==
          JSON.stringify(after.entries)
      )
        reasons.push("Comment toast History transition differs");
    } else if (JSON.stringify(after) !== JSON.stringify(before))
      reasons.push("Seek changed History");
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
      const validElapsed = (row: (typeof rows)[number]) =>
        row.valid &&
        typeof row.durationMs === "number" &&
        Number.isFinite(row.durationMs) &&
        row.durationMs >= 0;
      const times = rows
        .filter(
          (row) =>
            validElapsed(row) &&
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
            : rows.every(validElapsed)
              ? "pass"
              : "fail",
        reason:
          rows.length === 0
            ? "No attempt retained"
            : times.length < 5
              ? "Fewer than five valid baseline trials"
              : "Timing inconclusive until limiter and noise evidence are admitted",
        attempted: rows.length,
        valid: rows.filter(validElapsed).length,
        failed: rows.filter((row) => !validElapsed(row)).length,
        baselineValid: times.length,
        duration,
      };
    }),
  );
}
