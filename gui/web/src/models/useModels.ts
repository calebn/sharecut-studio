import { createContext, useContext, useMemo } from "react";
import type { ModelInstallState } from "../types/pipeline";
import type {
  DownloadOptions,
  DownloadOutcome,
  ModelView,
  WhisperChoice,
} from "./types";

export type ModelsApi = {
  /** Registry order; null until the first status arrives. */
  models: ModelView[] | null;
  tools: { ffmpeg: ModelInstallState; hint: string | null };
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
  refresh: () => Promise<void>;
};

export const ModelsContext = createContext<ModelsApi | null>(null);

/**
 * What the hooks report with no provider above them: share-review guests mount none, because they
 * must make no host bootstrap calls. Rows are absent, nothing is busy, and a download does nothing.
 */
export const INERT_MODELS: ModelsApi = {
  models: null,
  tools: { ffmpeg: "missing", hint: null },
  ready: false,
  busy: false,
  loadError: null,
  whisper: { variant: "", variants: [], choose: () => undefined },
  download: () => Promise.resolve({ kind: "cancelled" }),
  cancel: () => Promise.resolve(),
  refresh: () => Promise.resolve(),
};

export function useModels(): ModelsApi {
  return useContext(ModelsContext) ?? INERT_MODELS;
}

export function useModel(id: string): {
  row: ModelView | null;
  busy: boolean;
  download: (options?: DownloadOptions) => Promise<DownloadOutcome>;
} {
  const { models, busy, download } = useModels();
  const row = models?.find((m) => m.id === id) ?? null;
  return useMemo(
    () => ({ row, busy, download: (options) => download([id], options) }),
    [row, busy, download, id],
  );
}
