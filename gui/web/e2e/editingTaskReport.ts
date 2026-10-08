export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type DurableState = {
  clips: { [key: string]: Json }[];
  tracks: { [key: string]: Json }[];
  envelopes: Json[];
  comments: { [key: string]: Json }[];
};
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
  history?: {
    before: string | null;
    after: string | null;
    undone: string | null;
  };
};
export type TrialAssessment = {
  status: "pass" | "fail" | "pending";
  reasons: string[];
  activations: Record<Phase, number>;
  mutations: number;
  accidentalCommands: number;
  completedWork: number;
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
  return differences(expected, actual, prefix, tolerances);
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
      status: "pending",
      reasons: [route && "pending" in route ? route.pending : "unknown route"],
      activations,
      mutations: 0,
      accidentalCommands: 0,
      completedWork: 0,
    };
  let previous = 0;
  let mutations = 0;
  let accidentalCommands = 0;
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
          : {},
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
      if (Math.abs(trial.transport.seconds - definition.seek) > 0.03)
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
  };
}
