import type {
  BootstrapFailureKind,
  BootstrapStatus,
  WhisperModelChoice,
} from "../api";

export type ModelFailure = {
  /** Null for untyped plain text (an unexpected error). */
  kind: BootstrapFailureKind | null;
  /** Plain text safe to show: it names no path, URL or environment variable. */
  plain: string;
};

export type ModelFailureKey = `${string}/${string}`;
export type ModelFailures = Partial<Record<ModelFailureKey, ModelFailure>>;

export type ModelState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "installed" }
  | { kind: "missing" }
  | { kind: "update_needed" }
  /** This device cannot run it, so there is nothing to get. `hint` is the server's plain sentence. */
  | { kind: "unsupported"; hint: string }
  | { kind: "queued" }
  | { kind: "downloading"; bytes: number; total: number | null }
  | { kind: "failed"; failure: ModelFailure };

export type ModelObservation = {
  kind: "checking" | "current" | "unavailable";
  generation: number;
};

export type VariantStatus = {
  status: BootstrapStatus | null;
  observation: ModelObservation;
};

export type VariantStatuses = Partial<Record<string, VariantStatus>>;

export type TargetObservation = {
  row: ModelView | null;
  observation: ModelObservation;
};

export type ModelView = {
  id: string;
  label: string;
  purpose: string;
  tier: "required" | "recommended";
  size: string;
  sizeBytes: number | null;
  /** The model variant (a Whisper size, the aligner model); null when the model has one only. */
  variant: string | null;
  state: ModelState;
};

export type DownloadOutcome =
  | { kind: "ok" }
  | { kind: "failed"; failed: string[] }
  | { kind: "busy" }
  | { kind: "cancelled" };

export type RemoveOutcome =
  | { kind: "ok" }
  /** A download or job holds the server now; the model stays. */
  | { kind: "busy" }
  | { kind: "failed"; plain: string };

export type DownloadOptions = { whisperModel?: string };

export type WhisperChoice = {
  variant: string;
  variants: WhisperModelChoice[];
  choose: (variant: string) => void;
};
