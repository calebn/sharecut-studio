import type {
  BootstrapJobSnapshot,
  BootstrapStatus,
  ModelStatus,
} from "../api";
import type { ModelInstallState } from "../types/pipeline";
import { isTerminalJobStatus } from "../utils/pipeline";
import type { ModelFailure, ModelState, ModelView } from "./types";

export type ControllerState = {
  status: BootstrapStatus | null;
  loadError: string | null;
  /** The live (non-terminal) bootstrap job, ours or adopted. */
  job: BootstrapJobSnapshot | null;
  /** Per-row failure from the last terminal job; session memory only. */
  failures: Record<string, ModelFailure>;
  /** The Whisper size the person picked; the server's until they pick. */
  variant: string;
};

export type ControllerAction =
  | { type: "statusLoaded"; status: BootstrapStatus }
  | { type: "loadFailed"; message: string }
  | { type: "jobSeen"; job: BootstrapJobSnapshot | null }
  | { type: "downloadStarted"; ids: string[] }
  | { type: "failed"; failures: Record<string, ModelFailure> }
  | { type: "variantChosen"; variant: string };

export const initialState: ControllerState = {
  status: null,
  loadError: null,
  job: null,
  failures: {},
  variant: "",
};

function without(
  failures: Record<string, ModelFailure>,
  drop: (id: string) => boolean,
): Record<string, ModelFailure> {
  return Object.fromEntries(
    Object.entries(failures).filter(([id]) => !drop(id)),
  );
}

export function reduce(
  state: ControllerState,
  action: ControllerAction,
): ControllerState {
  switch (action.type) {
    case "statusLoaded": {
      const installed = new Set(
        action.status.models
          .filter((m) => m.state === "installed")
          .map((m) => m.id),
      );
      return {
        ...state,
        status: action.status,
        loadError: null,
        variant: action.status.whisper_model,
        failures: without(state.failures, (id) => installed.has(id)),
      };
    }
    case "loadFailed":
      return { ...state, loadError: action.message };
    case "jobSeen":
      return {
        ...state,
        job:
          action.job && !isTerminalJobStatus(action.job.status)
            ? action.job
            : null,
      };
    case "downloadStarted":
      return {
        ...state,
        failures: without(state.failures, (id) => action.ids.includes(id)),
      };
    case "failed":
      return { ...state, failures: { ...state.failures, ...action.failures } };
    case "variantChosen":
      return { ...state, variant: action.variant };
  }
}

function baseState(row: ModelStatus): ModelState {
  return { kind: row.state };
}

/** The server's rows with the live job and the session's failures laid over them. */
export function overlay(
  status: BootstrapStatus,
  job: BootstrapJobSnapshot | null,
  failures: Record<string, ModelFailure>,
): ModelView[] {
  const live = job && !isTerminalJobStatus(job.status) ? job : null;
  return status.models.map((row) => {
    let state: ModelState = baseState(row);
    if (live?.components.includes(row.id)) {
      state =
        live.download?.component === row.id
          ? {
              kind: "downloading",
              bytes: live.download.bytes,
              total: live.download.total,
            }
          : { kind: "queued" };
    } else if (failures[row.id] && row.state !== "installed") {
      state = { kind: "failed", failure: failures[row.id]! };
    }
    return {
      id: row.id,
      label: row.label,
      purpose: row.purpose,
      tier: row.tier,
      size: row.size,
      sizeBytes: row.size_bytes,
      variant: row.model !== row.id ? row.model : null,
      state,
    };
  });
}

export function toolsOf(status: BootstrapStatus | null): {
  ffmpeg: ModelInstallState;
  hint: string | null;
} {
  const ffmpeg = status?.tools.ffmpeg;
  return { ffmpeg: ffmpeg?.state ?? "missing", hint: ffmpeg?.hint ?? null };
}

type ComponentResult = {
  ok?: boolean;
  error?: string;
  failure?: { kind?: ModelFailure["kind"]; plain?: string };
};

/**
 * The per-row failures of a finished job. A component's own result wins: its typed `failure`, else
 * its plain `error`. A job that ended without results (an exception) charges `ids`, the requested
 * rows still not installed, with the job's `failure` or `error`.
 */
export function jobFailures(
  job: BootstrapJobSnapshot,
  ids: string[],
): Record<string, ModelFailure> {
  if (job.status !== "error") {
    return {};
  }
  const results = (
    job.result as { results?: Record<string, ComponentResult> } | null
  )?.results;
  if (!results) {
    const failure: ModelFailure = job.failure
      ? { kind: job.failure.kind, plain: job.failure.plain }
      : {
          kind: null,
          plain: job.error ?? job.message ?? "The download failed.",
        };
    return Object.fromEntries(ids.map((id) => [id, failure]));
  }
  const out: Record<string, ModelFailure> = {};
  for (const [id, result] of Object.entries(results)) {
    if (result.failure?.plain) {
      out[id] = {
        kind: result.failure.kind ?? null,
        plain: result.failure.plain,
      };
    } else if (result.ok === false) {
      out[id] = { kind: null, plain: result.error ?? "The download failed." };
    }
  }
  return out;
}
