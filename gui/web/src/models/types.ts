import type { BootstrapFailure, WhisperModelChoice } from "../api";

export type ModelFailure = {
  /** Null for untyped plain text (an unexpected error). */
  kind: BootstrapFailure["kind"] | null;
  /** Plain text safe to show: it names no path, URL or environment variable. */
  plain: string;
};

export type ModelState =
  | { kind: "installed" }
  | { kind: "missing" }
  | { kind: "update_needed" }
  | { kind: "queued" }
  | { kind: "downloading"; bytes: number; total: number | null }
  | { kind: "failed"; failure: ModelFailure };

export type ModelView = {
  id: string;
  label: string;
  purpose: string;
  tier: "required" | "recommended" | "offered";
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

export type DownloadOptions = { whisperModel?: string };

export type WhisperChoice = {
  variant: string;
  variants: WhisperModelChoice[];
  choose: (variant: string) => void;
};
