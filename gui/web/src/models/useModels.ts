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
};

export const ModelsContext = createContext<ModelsApi | null>(null);

export function useModels(): ModelsApi {
  const api = useContext(ModelsContext);
  if (!api) {
    throw new Error("useModels needs a ModelsProvider above it");
  }
  return api;
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
