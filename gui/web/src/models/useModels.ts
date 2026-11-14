import { createContext, useContext } from "react";
import type { ModelInstallState } from "../types/pipeline";
import type { NeedTarget } from "./capability";
import type {
  DownloadOptions,
  DownloadOutcome,
  ModelObservation,
  ModelView,
  RemoveOutcome,
  TargetObservation,
  WhisperChoice,
} from "./types";

export type ModelsApi = {
  /** Registry order; null until the first status arrives. */
  models: ModelView[] | null;
  /** Active downloads and retained failures, with their own variant identity. */
  downloads: ModelView[];
  observation: ModelObservation;
  lookup: (target: Pick<NeedTarget, "id" | "variant">) => TargetObservation;
  observe: (target: Pick<NeedTarget, "id" | "variant">) => Promise<void>;
  tools: { ffmpeg: ModelInstallState; hint: string | null };
  /** False on a device with no OS folder picker; Home then offers no Open other. */
  canPickFolder: boolean;
  ready: boolean;
  /** True while any bootstrap download runs, ours or another tab's. */
  busy: boolean;
  loadError: string | null;
  whisper: WhisperChoice;
  download: (
    ids: string[],
    options?: DownloadOptions,
  ) => Promise<DownloadOutcome>;
  cancel: () => Promise<void>;
  /** Deletes a downloaded model (for Whisper, the size `variant` names) and reads the status again. */
  remove: (id: string, variant?: string | null) => Promise<RemoveOutcome>;
  refresh: () => Promise<void>;
};

export const ModelsContext = createContext<ModelsApi | null>(null);

/**
 * What the hooks report with no provider above them: share-review guests mount none, because they
 * must make no host bootstrap calls. Rows are absent, nothing is busy, and a download does nothing.
 */
export const INERT_MODELS: ModelsApi = {
  lookup: () => ({
    row: null,
    observation: { kind: "checking", generation: 0 },
  }),
  observe: () => Promise.resolve(),
  models: null,
  downloads: [],
  observation: { kind: "checking", generation: 0 },
  tools: { ffmpeg: "missing", hint: null },
  canPickFolder: true,
  ready: false,
  busy: false,
  loadError: null,
  whisper: { variant: "", variants: [], choose: () => undefined },
  download: () => Promise.resolve({ kind: "cancelled" }),
  cancel: () => Promise.resolve(),
  remove: () => Promise.resolve({ kind: "busy" }),
  refresh: () => Promise.resolve(),
};

export function useModels(): ModelsApi {
  return useContext(ModelsContext) ?? INERT_MODELS;
}
