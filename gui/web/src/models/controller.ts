import type { BootstrapJobSnapshot, BootstrapStatus } from "../api";
import type { ModelInstallState } from "../types/pipeline";
import { isTerminalJobStatus } from "../utils/pipeline";
import { WHISPER_SIZES } from "./capability";
import type {
  ModelFailure,
  ModelFailureKey,
  ModelFailures,
  ModelObservation,
  ModelState,
  ModelView,
} from "./types";

export function failureKey(id: string, variant: string): ModelFailureKey {
  return `${id}/${id === "whisper" ? variant : ""}`;
}

export type ControllerState = {
  status: BootstrapStatus | null;
  loadError: string | null;
  /** The live (non-terminal) bootstrap job, ours or adopted. */
  job: BootstrapJobSnapshot | null;
  /** Per-row failure from the last terminal job; session memory only. */
  failures: ModelFailures;
  /** The Whisper size the person picked; the server's until they pick. */
  variant: string;
  /** True once the person (or their download) picked a size; a reload then keeps it. */
  picked: boolean;
  observation: ModelObservation;
};

export type ControllerAction =
  | { type: "loadStarted" }
  | { type: "statusLoaded"; status: BootstrapStatus }
  | { type: "loadFailed"; message: string }
  | { type: "jobSeen"; job: BootstrapJobSnapshot | null }
  | { type: "downloadStarted"; ids: string[]; variant: string }
  | { type: "failed"; failures: ModelFailures }
  | { type: "variantChosen"; variant: string };

export const initialState: ControllerState = {
  status: null,
  loadError: null,
  job: null,
  failures: {},
  variant: "",
  picked: false,
  observation: { kind: "checking", generation: 0 },
};

function without(
  failures: ModelFailures,
  drop: (key: string) => boolean,
): ModelFailures {
  return Object.fromEntries(
    Object.entries(failures).filter(([id]) => !drop(id)),
  );
}

export function reduce(
  state: ControllerState,
  action: ControllerAction,
): ControllerState {
  switch (action.type) {
    case "loadStarted":
      return {
        ...state,
        loadError: null,
        observation: {
          kind: "checking",
          generation: state.observation.generation + 1,
        },
      };
    case "statusLoaded": {
      const variant = state.picked
        ? state.variant
        : action.status.whisper_model;
      // A row says "installed" for the size the status was read for; only that size's row
      // may clear a failure.
      const installed = new Set<string>(
        action.status.models
          .filter(
            (m) =>
              m.state === "installed" &&
              (m.id !== "whisper" || action.status.whisper_model === variant),
          )
          .map((m) => failureKey(m.id, action.status.whisper_model)),
      );
      return {
        ...state,
        status: action.status,
        loadError: null,
        variant,
        observation: { ...state.observation, kind: "current" },
        failures: without(state.failures, (key) => installed.has(key)),
      };
    }
    case "loadFailed":
      return {
        ...state,
        loadError: action.message,
        observation: { ...state.observation, kind: "unavailable" },
      };
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
        failures: without(state.failures, (key) =>
          action.ids.some((id) => failureKey(id, action.variant) === key),
        ),
      };
    case "failed":
      return { ...state, failures: { ...state.failures, ...action.failures } };
    case "variantChosen":
      return {
        ...state,
        variant: action.variant,
        picked: true,
      };
  }
}

export function overlay(
  status: BootstrapStatus,
  job: BootstrapJobSnapshot | null,
  failures: ModelFailures,
  variant: string = status.whisper_model,
  startingModelIds: readonly string[] = [],
  readState: ModelObservation["kind"] = "current",
): ModelView[] {
  const live = job && !isTerminalJobStatus(job.status) ? job : null;
  return status.models.map((row) => {
    const foreign = row.id === "whisper" && status.whisper_model !== variant;
    const failure = failures[failureKey(row.id, variant)];
    let state: ModelState = { kind: row.state };
    if (
      live?.components.includes(row.id) &&
      (row.id !== "whisper" || live.whisper_model === variant)
    ) {
      state =
        live.download?.component === row.id
          ? {
              kind: "downloading",
              bytes: live.download.bytes,
              total: live.download.total,
            }
          : { kind: "queued" };
    } else if (startingModelIds.includes(row.id)) {
      state = { kind: "queued" };
    } else if (readState !== "current") {
      state = { kind: readState === "checking" ? "checking" : "unavailable" };
    } else if (
      failure &&
      (row.state !== "installed" ||
        (row.id === "whisper" && status.whisper_model !== variant))
    ) {
      state = { kind: "failed", failure };
    } else if (foreign) {
      state = { kind: "unavailable" };
    }
    return {
      id: row.id,
      label: row.label,
      purpose: row.purpose,
      tier: row.tier,
      size: foreign
        ? (status.whisper_models.find((choice) => choice.id === variant)
            ?.size ??
          WHISPER_SIZES.find((choice) => choice.id === variant)?.size ??
          "")
        : row.size,
      sizeBytes: foreign ? null : row.size_bytes,
      variant: foreign ? variant : row.model !== row.id ? row.model : null,
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
): ModelFailures {
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
    return Object.fromEntries(
      ids.map((id) => [failureKey(id, job.whisper_model), failure]),
    );
  }
  const out: ModelFailures = {};
  for (const [id, result] of Object.entries(results)) {
    if (result.failure?.plain) {
      out[failureKey(id, job.whisper_model)] = {
        kind: result.failure.kind ?? null,
        plain: result.failure.plain,
      };
    } else if (result.ok === false) {
      out[failureKey(id, job.whisper_model)] = {
        kind: null,
        plain: result.error ?? "The download failed.",
      };
    }
  }
  return out;
}

export function downloadRows(
  status: BootstrapStatus,
  job: BootstrapJobSnapshot | null,
  failures: ModelFailures,
  selected: readonly ModelView[],
): ModelView[] {
  const relevant = (row: ModelView) =>
    row.state.kind === "queued" ||
    row.state.kind === "downloading" ||
    row.state.kind === "failed";
  const variants = new Set(
    Object.keys(failures)
      .filter((key) => key.startsWith("whisper/"))
      .map((key) => key.slice("whisper/".length)),
  );
  if (job?.components.includes("whisper")) variants.add(job.whisper_model);
  const rows = selected.filter(relevant);
  for (const variant of variants) {
    if (
      selected.some((row) => row.id === "whisper" && row.variant === variant)
    ) {
      continue;
    }
    const row = overlay(status, job, failures, variant).find(
      (row) => row.id === "whisper",
    );
    if (row && relevant(row)) rows.push(row);
  }
  return rows;
}
