import type { BackendEvidence } from "./editingBackendIdentity";
import {
  type DurableState,
  type Json,
  parseDurableState,
  savedStateDifferences,
} from "./editingTaskState";
export type Phase = "setup" | "action" | "cancel" | "undo";
export type EvidenceOrigin =
  | { owner: "main"; phase: "setup" | "action" | "undo" }
  | { owner: "cancel"; phase: "setup" | "cancel"; probe: string };
export type FailureOwner =
  | EvidenceOrigin
  | { owner: "cancel"; phase: "cancel"; probe: null }
  | { owner: "global"; blocks: "admission" | "all-proofs" };
export type TrialFailure = {
  origin: FailureOwner;
  error: string;
  errorName: string | null;
};
export type CancellationInput =
  | { kind: "route-cancel" }
  | {
      kind: "comment-swipe";
      dx: number;
      dy: number;
      end: "touchEnd" | "touchCancel";
    };
export type CancellationProbe = { id: string; input: CancellationInput };
export type JournalEvent = { seq: number } & EvidenceOrigin &
  (
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
        kind: "read-body-failed" | "command-body-failed";
        requestId: number;
        status: number;
        error: string;
        errorName: string | null;
      }
    | { kind: "error"; message: string }
  );
export type TaskRoute =
  | {
      id: string;
      input: "pointer" | "keyboard" | "numeric" | "cdp-touch";
      command: string | null;
      mutations: number;
      cancellation: readonly CancellationProbe[];
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
  undone?: DurableState;
  transport?: { seconds: number; playing: boolean };
  durationMs?: number;
  failures: TrialFailure[];
  profiler?: string;
  protocolHash?: string;
  backend?: { before: BackendEvidence; after?: BackendEvidence };
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
    origin: EvidenceOrigin;
    geometry: Json;
    screenshot?: string;
  }[];
  cancellations: (
    | { probe: string; outcome: "completed"; state: DurableState }
    | { probe: string; outcome: "failed"; state: DurableState | null }
  )[];
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

function validOrigin<T>(value: T): value is T & EvidenceOrigin {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if ("blocks" in row) return false;
  return row.owner === "main"
    ? ["setup", "action", "undo"].includes(row.phase as string) &&
        !("probe" in row)
    : row.owner === "cancel" &&
        ["setup", "cancel"].includes(row.phase as string) &&
        typeof row.probe === "string" &&
        row.probe.length > 0;
}
function sameOrigin(a: EvidenceOrigin, b: EvidenceOrigin): boolean {
  return (
    a.owner === b.owner &&
    a.phase === b.phase &&
    (a.owner !== "cancel" || (b.owner === "cancel" && a.probe === b.probe))
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
    "command-body-failed",
    "error",
  ];
  for (const row of input) {
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      !phases.includes(row.phase) ||
      !validOrigin(row) ||
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
      [
        "response",
        "read-response",
        "read-body-failed",
        "command-body-failed",
      ].includes(row.kind) &&
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
    if (
      (row.kind === "read-body-failed" || row.kind === "command-body-failed") &&
      !(row.errorName === null || typeof row.errorName === "string")
    )
      throw new Error("Invalid retained native error name");
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
type ValidationReasons = {
  admission: string[];
  integrity: string[];
  mainSetup: string[];
  save: string[];
  cancel: string[];
  undo: string[];
  probes: Map<string, { setup: string[]; cancel: string[] }>;
};
export function assessEditingTrial(
  definition: TaskDefinition,
  trial: EditingTrial,
): TrialAssessment {
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
  const owned: ValidationReasons = {
    admission: [],
    integrity: [],
    mainSetup: [],
    save: [],
    cancel: [],
    undo: [],
    probes: new Map(),
  };
  const reject = (origin: FailureOwner, ...messages: string[]) => {
    const target =
      origin.owner === "global"
        ? origin.blocks === "admission"
          ? owned.admission
          : owned.integrity
        : origin.owner === "main"
          ? origin.phase === "setup"
            ? owned.mainSetup
            : origin.phase === "action"
              ? owned.save
              : owned.undo
          : origin.probe === null
            ? owned.cancel
            : (owned.probes.get(origin.probe)?.[
                origin.phase === "setup" ? "setup" : "cancel"
              ] ?? owned.cancel);
    target.push(...messages);
  };
  const trust: FailureOwner = { owner: "global", blocks: "all-proofs" };
  const mainSetup: EvidenceOrigin = { owner: "main", phase: "setup" };
  const save: EvidenceOrigin = { owner: "main", phase: "action" };
  const undo: EvidenceOrigin = { owner: "main", phase: "undo" };
  if (
    typeof trial.durationMs !== "number" ||
    !Number.isFinite(trial.durationMs) ||
    trial.durationMs < 0
  )
    owned.admission.push("elapsed duration is missing, non-finite or negative");
  try {
    if (!Array.isArray(route.cancellation))
      throw new Error("Invalid cancellation declaration");
    for (const probe of route.cancellation) {
      if (
        !probe ||
        typeof probe.id !== "string" ||
        !probe.id ||
        owned.probes.has(probe.id) ||
        !probe.input ||
        !(
          probe.input.kind === "route-cancel" ||
          (probe.input.kind === "comment-swipe" &&
            Number.isFinite(probe.input.dx) &&
            Number.isFinite(probe.input.dy) &&
            ["touchEnd", "touchCancel"].includes(probe.input.end))
        )
      )
        throw new Error("Invalid or duplicate cancellation declaration");
      owned.probes.set(probe.id, { setup: [], cancel: [] });
    }
    parseEditingJournal(trial.journal);
    if (!Array.isArray(trial.failures))
      throw new Error("Invalid retained failures");
    for (const failure of trial.failures) {
      const origin = failure?.origin;
      if (
        !failure ||
        typeof failure.error !== "string" ||
        !(
          failure.errorName === null || typeof failure.errorName === "string"
        ) ||
        !(
          validOrigin(origin) ||
          (origin?.owner === "cancel" &&
            origin.phase === "cancel" &&
            origin.probe === null &&
            !("blocks" in origin)) ||
          (origin?.owner === "global" &&
            ["admission", "all-proofs"].includes(origin.blocks) &&
            !("phase" in origin) &&
            !("probe" in origin))
        )
      )
        throw new Error("Invalid retained failure ownership or payload");
    }
    if (!Array.isArray(trial.cancellations))
      throw new Error("Invalid retained cancellation results");
    for (const row of trial.cancellations) {
      if (
        !row ||
        typeof row.probe !== "string" ||
        !["completed", "failed"].includes(row.outcome) ||
        (row.state === null && row.outcome !== "failed")
      )
        throw new Error("Invalid retained cancellation result");
      if (row.state !== null) parseDurableState(row.state);
    }
    for (const state of [trial.before, trial.after, trial.undone])
      if (state !== undefined) parseDurableState(state);
    for (const row of trial.uiEvidence ?? [])
      if (!validOrigin(row.origin))
        throw new Error("Invalid retained UI ownership");
  } catch (error) {
    reject(trust, String(error));
  }
  if (owned.integrity.length)
    return {
      status: "fail",
      reasons: [...owned.admission, ...owned.integrity],
      activations,
      mutations: 0,
      accidentalCommands: 0,
      completedWork: 0,
      canceledReads: 0,
      observations: {
        save: "fail",
        cancel:
          !Array.isArray(route.cancellation) || route.cancellation.length
            ? "fail"
            : "not-applicable",
        undo: route.undo === "none" ? "not-applicable" : "fail",
      },
    };
  for (const failure of trial.failures) reject(failure.origin, failure.error);
  for (const origin of [
    ...trial.journal,
    ...trial.failures.map((row) => row.origin),
    ...(trial.uiEvidence ?? []).map((row) => row.origin),
  ])
    if (
      origin.owner === "cancel" &&
      origin.probe !== null &&
      !owned.probes.has(origin.probe)
    )
      reject(origin, `unexpected cancellation origin ${origin.probe}`);
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
      reject(trust, `duplicate request ${request.requestId}`);
    if (request.kind === "read-request") {
      const terminal = trial.journal.filter(
        (row) =>
          (row.kind === "read-response" || row.kind === "read-failed") &&
          row.requestId === request.requestId,
      );
      if (terminal.length !== 1)
        reject(
          request,
          `read ${request.requestId} has ${terminal.length} terminal outcomes`,
        );
    }
  }
  for (const outcome of trial.journal) {
    if (
      ![
        "response",
        "command-body-failed",
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
      ["response", "command-body-failed"].includes(outcome.kind) !==
        (request.kind === "request")
    ) {
      reject(trust, `orphan outcome ${outcome.requestId}`);
    } else if (outcome.seq <= request.seq || !sameOrigin(outcome, request)) {
      const message = `outcome ${outcome.requestId} order or phase differs`;
      reject(request, message);
      if (!sameOrigin(outcome, request)) reject(outcome, message);
    }
    if (
      outcome.kind === "read-response" &&
      request?.kind === "read-request" &&
      new URL(request.url).pathname === "/api/document/state" &&
      outcome.status >= 200 &&
      outcome.status < 300 &&
      !documentStateBody(outcome.body)
    )
      reject(outcome, `read ${outcome.requestId} has invalid document state`);
  }
  let previous = 0,
    mutations = 0,
    accidentalCommands = 0,
    canceledReads = 0;
  for (const event of trial.journal) {
    if (event.seq <= previous)
      reject(trust, "journal sequence is not increasing");
    previous = event.seq;
    if (event.kind === "activation") {
      activations[event.phase]++;
      if (event.outcome !== "completed")
        reject(event, `activation ${event.label} ${event.outcome}`);
    }
    if (event.kind === "error") reject(event, event.message);
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
          sameOrigin(read, event) &&
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
              !sameOrigin(candidate, read) ||
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
              outcomes.some(
                (response) =>
                  response.kind === "read-response" &&
                  sameOrigin(response, candidate) &&
                  response.seq > candidate.seq &&
                  response.seq > event.seq &&
                  response.status >= 200 &&
                  response.status < 300 &&
                  documentStateBody(response.body) &&
                  JSON.parse(response.body).resync !== true,
              )
            );
          });
      }
      if (replaced) {
        canceledReads++;
        admittedAborts.add(event.requestId);
      } else
        reject(
          event,
          `read ${event.requestId} failed ${event.error} without admitted replacement`,
        );
    }
    if (
      event.kind === "read-response" &&
      (event.status < 200 || event.status >= 300)
    )
      reject(event, `read ${event.requestId} failed HTTP ${event.status}`);
    if (event.kind === "command-body-failed")
      reject(event, `command body ${event.requestId} failed ${event.error}`);
    if (event.kind !== "request") continue;
    const terminals = trial.journal.filter(
      (item) =>
        (item.kind === "response" || item.kind === "command-body-failed") &&
        item.requestId === event.requestId,
    );
    if (terminals.length !== 1)
      reject(
        event,
        `request ${event.requestId} has ${terminals.length ? "multiple responses" : "no response"}`,
      );
    const response = terminals[0];
    if (response?.kind === "response") {
      try {
        const body = JSON.parse(response.body) as Record<string, unknown>;
        if (body.ok !== true || body.type !== "Applied")
          reject(event, `request ${event.requestId} has unknown outcome`);
      } catch {
        reject(event, `request ${event.requestId} has invalid response JSON`);
      }
      if (response.status < 200 || response.status >= 300)
        reject(event, `request ${event.requestId} failed ${response.status}`);
    }
    if (event.phase === "setup" || event.phase === "cancel") {
      accidentalCommands++;
      reject(
        event,
        event.phase === "setup"
          ? `unexpected setup command ${event.type}`
          : `cancellation command ${event.type}`,
      );
    }
    if (event.phase === "action") {
      if (event.type !== route.command) {
        accidentalCommands++;
        reject(event, `unexpected action command ${event.type}`);
      }
      if (
        response?.kind === "response" &&
        response.status >= 200 &&
        response.status < 300
      )
        mutations++;
    }
    if (
      event.phase === "undo" &&
      (route.undo === "none" ||
        event.type !==
          (route.undo === "comment-toast" ? "ResolveComment" : "UndoHistory"))
    ) {
      accidentalCommands++;
      reject(event, `unexpected Undo command ${event.type}`);
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
        reject(event, `read body ${event.requestId} failed ${event.error}`);
    }
  if (mutations !== route.mutations)
    reject(
      save,
      `action expected ${route.mutations} mutations, observed ${mutations}`,
    );
  if (mutations > route.mutations)
    accidentalCommands += mutations - route.mutations;
  if (!trial.before) reject(mainSetup, "starting state not observed");
  else
    reject(
      mainSetup,
      ...savedStateDifferences(definition.start, trial.before, "before"),
    );
  if (!trial.after) reject(save, "saved result not observed");
  else {
    reject(
      save,
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
      reject(save, "task made no saved change");
  }
  if (definition.seek !== undefined) {
    if (!trial.transport) reject(save, "transport not observed");
    else {
      if (trial.transport.playing !== false)
        reject(save, "seek stopped playback state not observed");
      if (!Number.isFinite(trial.transport.seconds))
        reject(save, "seek position is not finite");
      else if (Math.abs(trial.transport.seconds - definition.seek) > 0.03)
        reject(
          save,
          `seek expected ${definition.seek}, observed ${trial.transport.seconds}`,
        );
    }
  }
  if (activations.action === 0) reject(save, "task input not observed");
  if (route.cancellation.length && activations.cancel === 0)
    owned.cancel.push("cancel input not observed");
  if (route.undo !== "none" && activations.undo === 0)
    reject(undo, "Undo input not observed");
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
      reject(
        undo,
        `Undo expected ${route.mutations} ${expectedUndo} commands, observed ${undoRequests.length}`,
      );
  }
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
  const identities = trial.history;
  const before = identities?.before,
    after = identities?.after,
    undone = identities?.undone;
  if (!validHistory(before))
    reject(
      { owner: "main", phase: "setup" },
      "History starting evidence missing or invalid",
    );
  if (!validHistory(after))
    reject(
      { owner: "main", phase: "action" },
      "History saved evidence missing or invalid",
    );
  if (route.undo !== "none" && !validHistory(undone))
    reject(
      { owner: "main", phase: "undo" },
      "History Undo evidence missing or invalid",
    );
  if (validHistory(before) && validHistory(after)) {
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
        reject(
          { owner: "main", phase: "action" },
          "History action transition differs",
        );
      if (
        validHistory(undone) &&
        (undone.cursor !== baseline ||
          undone.headId !== after.entries[baseline]?.id ||
          JSON.stringify(undone.entries) !== JSON.stringify(after.entries))
      )
        reject(
          { owner: "main", phase: "undo" },
          "History Undo transition differs",
        );
    } else if (route.undo === "comment-toast") {
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
        reject(
          { owner: "main", phase: "action" },
          "Comment resolve History transition differs",
        );
      if (
        validHistory(undone) &&
        (undone.cursor !== baseline + 2 ||
          undone.entries.length !== baseline + 3 ||
          undone.headId === after.headId ||
          undone.entries[baseline + 2]?.label !== "after unresolve comment" ||
          undone.entries[baseline + 2]?.operation !== null ||
          JSON.stringify(undone.entries.slice(0, after.entries.length)) !==
            JSON.stringify(after.entries))
      )
        reject(
          { owner: "main", phase: "undo" },
          "Comment toast History transition differs",
        );
    } else if (JSON.stringify(after) !== JSON.stringify(before))
      reject({ owner: "main", phase: "action" }, "Seek changed History");
  }

  for (const result of trial.cancellations)
    if (!owned.probes.has(result.probe))
      owned.cancel.push(`unexpected cancellation ${result.probe}`);
  for (const probe of route.cancellation) {
    const origin: EvidenceOrigin = {
      owner: "cancel",
      phase: "cancel",
      probe: probe.id,
    };
    const results = trial.cancellations.filter((row) => row.probe === probe.id);
    if (results.length !== 1)
      reject(origin, `cancellation ${probe.id} has ${results.length} results`);
    const inputs = trial.journal.filter(
      (row) =>
        row.kind === "activation" &&
        row.owner === "cancel" &&
        row.phase === "cancel" &&
        row.probe === probe.id,
    );
    if (!inputs.length)
      reject(origin, `cancellation ${probe.id} input not observed`);
    for (const result of results) {
      if (result.outcome !== "completed")
        reject(origin, `cancellation ${probe.id} failed`);
      if (result.state)
        reject(
          origin,
          ...savedStateDifferences(
            definition.start,
            result.state,
            `canceled-${probe.id}`,
          ),
        );
    }
  }
  if (route.undo !== "none") {
    if (!trial.undone) reject(undo, "Undo not run");
    else
      reject(
        undo,
        ...savedStateDifferences(definition.start, trial.undone, "undone"),
      );
  }
  const probeReasons = [...owned.probes.values()].flatMap((row) => [
    ...row.setup,
    ...row.cancel,
  ]);
  const reasons = [
    ...owned.admission,
    ...owned.integrity,
    ...owned.mainSetup,
    ...owned.save,
    ...owned.cancel,
    ...probeReasons,
    ...owned.undo,
  ];
  const attempted = (owner: "main" | "cancel", phase?: Phase) =>
    trial.journal.some(
      (row) => row.owner === owner && (!phase || row.phase === phase),
    ) ||
    trial.failures.some(
      (row) =>
        row.origin.owner === owner &&
        (!phase || ("phase" in row.origin && row.origin.phase === phase)),
    ) ||
    (trial.uiEvidence ?? []).some(
      (row) =>
        row.origin.owner === owner && (!phase || row.origin.phase === phase),
    );
  const observation = (
    applicable: boolean,
    started: boolean,
    own: string[],
    prerequisites: string[],
  ): ObservationStatus =>
    !applicable
      ? "not-applicable"
      : prerequisites.length
        ? "fail"
        : !started
          ? "not-run"
          : own.length
            ? "fail"
            : "pass";
  return {
    status: reasons.length ? "fail" : "pass",
    reasons,
    activations,
    mutations,
    accidentalCommands,
    completedWork: reasons.length ? 0 : 1,
    canceledReads,
    observations: {
      save: observation(
        true,
        Boolean(trial.after) || attempted("main", "action"),
        owned.save,
        [...owned.integrity, ...owned.mainSetup],
      ),
      cancel: observation(
        Boolean(route.cancellation.length),
        Boolean(trial.cancellations.length) || attempted("cancel"),
        [...owned.cancel, ...probeReasons],
        owned.integrity,
      ),
      undo: observation(
        route.undo !== "none",
        Boolean(trial.undone) || attempted("main", "undo"),
        owned.undo,
        [...owned.integrity, ...owned.mainSetup, ...owned.save],
      ),
    },
  };
}

export type EditingSummaryAttempt = {
  task: string;
  route: string;
  trial: number;
} & (
  | { kind: "not-run"; reason: string }
  | { kind: "rejected"; mode: EditingTrial["mode"] }
  | { kind: "admitted"; mode: EditingTrial["mode"]; durationMs: number }
);

export function summarizeEditingAttempts(
  definitions: TaskDefinition[],
  attempts: readonly EditingSummaryAttempt[],
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
          notRun: 0,
          baselineValid: 0,
          duration: null,
        };
      const rows = attempts.filter(
        (attempt) => attempt.task === task.id && attempt.route === route.id,
      );
      const admitted = rows.filter(
        (row): row is Extract<EditingSummaryAttempt, { kind: "admitted" }> =>
          row.kind === "admitted",
      );
      const notRun = rows.filter(
        (row): row is Extract<EditingSummaryAttempt, { kind: "not-run" }> =>
          row.kind === "not-run",
      );
      const times = admitted
        .filter((row) => row.mode === "baseline")
        .map((row) => row.durationMs)
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
      const attempted = rows.length - notRun.length;
      return {
        task: task.id,
        route: route.id,
        status:
          attempted === 0
            ? "not-run"
            : admitted.length === rows.length
              ? "pass"
              : "fail",
        reason: notRun.length
          ? notRun[0].reason
          : rows.length === 0
            ? "No scheduled attempt"
            : times.length < 5
              ? "Fewer than five valid baseline trials"
              : "Timing inconclusive until limiter and noise evidence are admitted",
        attempted,
        valid: admitted.length,
        failed: rows.filter((row) => row.kind === "rejected").length,
        notRun: notRun.length,
        baselineValid: times.length,
        duration,
      };
    }),
  );
}
