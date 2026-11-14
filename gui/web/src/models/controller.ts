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
  VariantStatuses,
} from "./types";
import { unsupportedSentence } from "./unsupported";

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
  picked: boolean;
  observation: ModelObservation;
  variants: VariantStatuses;
};

export type ControllerAction =
  | { type: "variantReadStarted"; variant: string; generation: number }
  | {
      type: "variantReadFinished";
      variant: string;
      generation: number;
      status: BootstrapStatus | null;
    }
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
  variants: {},
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
    case "variantReadStarted":
      return {
        ...state,
        variants: {
          ...state.variants,
          [action.variant]: {
            status: state.variants[action.variant]?.status ?? null,
            observation: { kind: "checking", generation: action.generation },
          },
        },
      };
    case "variantReadFinished": {
      const previous = state.variants[action.variant];
      if (previous && previous.observation.generation > action.generation)
        return state;
      const status =
        action.status?.whisper_model === action.variant ? action.status : null;
      const installed =
        status?.models.find((row) => row.id === "whisper")?.state ===
        "installed";
      return {
        ...state,
        variants: {
          ...state.variants,
          [action.variant]: {
            status: status ?? previous?.status ?? null,
            observation: {
              kind: status ? "current" : "unavailable",
              generation: action.generation,
            },
          },
        },
        failures: installed
          ? without(
              state.failures,
              (key) => key === failureKey("whisper", action.variant),
            )
          : state.failures,
      };
    }
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

type RowStateContext = {
  live: BootstrapJobSnapshot | null;
  foreign: boolean;
  failure: ModelFailure | undefined;
  starting: boolean;
  readState: ModelObservation["kind"];
  variant: string;
  whisperModel: string;
};

function rowState(
  row: BootstrapStatus["models"][number],
  {
    live,
    foreign,
    failure,
    starting,
    readState,
    variant,
    whisperModel,
  }: RowStateContext,
): ModelState {
  if (row.state === "unsupported") {
    return { kind: "unsupported", hint: unsupportedSentence(row.hint) };
  }
  if (
    live?.components.includes(row.id) &&
    (row.id !== "whisper" || live.whisper_model === variant)
  ) {
    return live.download?.component === row.id
      ? {
          kind: "downloading",
          bytes: live.download.bytes,
          total: live.download.total,
        }
      : { kind: "queued" };
  }
  if (starting) return { kind: "queued" };
  if (readState !== "current") {
    return { kind: readState === "checking" ? "checking" : "unavailable" };
  }
  if (
    failure &&
    (row.state !== "installed" ||
      (row.id === "whisper" && whisperModel !== variant))
  ) {
    return { kind: "failed", failure };
  }
  return foreign ? { kind: "unavailable" } : { kind: row.state };
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
    const state = rowState(row, {
      live,
      foreign,
      failure,
      starting: startingModelIds.includes(row.id),
      readState,
      variant,
      whisperModel: status.whisper_model,
    });
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

/** Whether this device has an OS folder picker; true until the first status says otherwise. */
export function canPickFolderOf(status: BootstrapStatus | null): boolean {
  return status?.host.folder_picker ?? true;
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
  const targets = new Set(
    Object.keys(failures)
      .filter((key) => key.startsWith("whisper/"))
      .map((key) => key.slice("whisper/".length)),
  );
  if (job?.components.includes("whisper")) targets.add(job.whisper_model);
  const rows = selected.filter(relevant);
  for (const variant of targets) {
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
  if (!job || isTerminalJobStatus(job.status)) return rows;
  const active = overlay(status, job, failures, job.whisper_model);
  const ordered = job.components.flatMap((id): ModelView[] => {
    const row = active.find((model) => model.id === id);
    if (!row) return [];
    if (job.failed_components.includes(id)) {
      return [
        {
          ...row,
          state: {
            kind: "failed",
            failure: { kind: null, plain: "The download failed." },
          },
        },
      ];
    }
    return [row];
  });
  return [
    ...ordered,
    ...rows.filter(
      (row) =>
        !ordered.some(
          (active) => active.id === row.id && active.variant === row.variant,
        ),
    ),
  ];
}
