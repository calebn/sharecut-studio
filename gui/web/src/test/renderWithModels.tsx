import { act, type RenderResult, render } from "@testing-library/react";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { vi } from "vitest";
import type {
  BootstrapHost,
  BootstrapJobSnapshot,
  BootstrapStatus,
} from "../api";
import {
  canPickFolderOf,
  downloadRows,
  overlay,
  toolsOf,
} from "../models/controller";
import type {
  DownloadOutcome,
  ModelFailures,
  RemoveOutcome,
} from "../models/types";
import { type ModelsApi, ModelsContext } from "../models/useModels";

export type ModelsFixture = {
  status: BootstrapStatus;
  job?: BootstrapJobSnapshot | null;
  failures?: ModelFailures;
  download?: ModelsApi["download"];
};

let observationGeneration = 0;

/** A static ModelsApi for consumer tests: the real overlay over a status fixture, spy actions. */
export function modelsApi(fixture: ModelsFixture): ModelsApi {
  const { status, job = null, failures = {} } = fixture;
  const models = overlay(status, job, failures);
  const api: ModelsApi = {
    models,
    downloads: downloadRows(status, job, failures, models),
    lookup: (target) => ({
      row:
        api.models?.find(
          (row) =>
            row.id === target.id &&
            (target.id !== "whisper" ||
              !target.variant ||
              row.variant === target.variant),
        ) ?? null,
      observation: api.observation,
    }),
    observe: () => api.refresh(),
    observation: { kind: "current", generation: ++observationGeneration },
    tools: toolsOf(status),
    canPickFolder: canPickFolderOf(status),
    ready: status.ready,
    busy: job !== null,
    loadError: null,
    whisper: {
      variant: status.whisper_model,
      variants: status.whisper_models,
      choose: vi.fn(),
    },
    download:
      fixture.download ??
      vi.fn(async (): Promise<DownloadOutcome> => ({ kind: "ok" })),
    cancel: vi.fn(async () => undefined),
    remove: vi.fn(async (): Promise<RemoveOutcome> => ({ kind: "ok" })),
    refresh: vi.fn(async () => undefined),
  };
  return api;
}

/** A `wrapper` for RTL `render` that supplies `api` (so `rerender` keeps it). */
export function modelsWrapper(api: ModelsApi) {
  return function ModelsWrapper({ children }: { children: ReactNode }) {
    return (
      <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
    );
  };
}

/** Render `ui` under a models context holding `fixture`; returns the render and the api spies. */
export function renderWithModels(
  ui: ReactElement,
  fixture: ModelsFixture,
): RenderResult & { api: ModelsApi } {
  const api = modelsApi(fixture);
  const result = render(ui, { wrapper: modelsWrapper(api) });
  return Object.assign(result, { api });
}

export function renderWithLanding(
  ui: ReactElement,
  fixture: ModelsFixture,
): RenderResult & { api: ModelsApi; land: (id: string) => void } {
  const base = modelsApi(fixture);
  let mark: (id: string) => void = () => undefined;
  function Landing({ children }: { children: ReactNode }) {
    const [landed, setLanded] = useState<string[]>([]);
    mark = (id) => setLanded((ids) => [...ids, id]);
    const api = useMemo<ModelsApi>(() => {
      const next = modelsApi({
        ...fixture,
        status: {
          ...fixture.status,
          models: fixture.status.models.map((row) =>
            landed.includes(row.id) ? { ...row, state: "installed" } : row,
          ),
        },
      });
      next.download = base.download;
      next.cancel = base.cancel;
      next.remove = base.remove;
      next.refresh = base.refresh;
      return next;
    }, [landed]);
    return (
      <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
    );
  }
  const result = render(ui, { wrapper: Landing });
  return Object.assign(result, {
    api: base,
    land: (id: string) => act(() => mark(id)),
  });
}

/** What a Mac reports (`GET /api/bootstrap/status` `host`). */
export const DESKTOP_HOST: BootstrapHost = {
  name: "macos",
  can_spawn_processes: true,
  loopback_is_trusted: true,
  media_tools: "executables",
  transcription: "faster_whisper",
  folder_picker: true,
};

export const WHISPER_CATALOG = [
  {
    id: "large-v3-turbo",
    label: "Recommended",
    size: "~1.6 GB",
    description: "Lowest practical error for podcasts.",
  },
  {
    id: "small.en",
    label: "Balanced (English)",
    size: "~500 MB",
    description: "Good laptop default if disk is tight.",
  },
];

type Row = BootstrapStatus["models"][number];

/** A status row with registry-shaped defaults; the first row of a fixture is usually Whisper. */
export function modelRow(over: Partial<Row> & { id: string }): Row {
  return {
    label: over.id,
    purpose: "purpose",
    tier: "recommended",
    model: over.id,
    size: "~1 MB",
    size_bytes: 1_000_000,
    state: "missing",
    ...over,
  };
}

export function modelStatus(
  models: Row[],
  over: Partial<BootstrapStatus> = {},
): BootstrapStatus {
  return {
    ready: false,
    cdn_base: false,
    whisper_model: "large-v3-turbo",
    whisper_models: WHISPER_CATALOG,
    host: DESKTOP_HOST,
    tools: { ffmpeg: { state: "installed", source: "bundled", hint: null } },
    models,
    ...over,
  };
}

/** The four registry rows in registry order, as a fresh machine reports them. */
export function registryRows(): Row[] {
  return [
    modelRow({
      id: "whisper",
      label: "Whisper",
      purpose: "transcription",
      tier: "required",
      model: "large-v3-turbo",
      size: "~1.6 GB",
      size_bytes: 1_600_000_000,
    }),
    modelRow({
      id: "rnnoise",
      label: "Noise reduction (RNNoise)",
      purpose: "noise reduction",
      tier: "recommended",
      size: "~0.3 MB",
      size_bytes: 297_646,
    }),
    modelRow({
      id: "word-aligner",
      label: "Word aligner",
      purpose: "precise word boundaries",
      tier: "recommended",
      model: "wav2vec2",
      size: "~360 MB",
      size_bytes: 360_000_000,
    }),
    modelRow({
      id: "speaker-ecapa",
      label: "Speaker model",
      purpose: "speaker recognition and split",
      tier: "recommended",
      size: "~80 MB",
      size_bytes: 80_000_000,
    }),
  ];
}

/** A `wrapper` over the fresh-machine registry rows, for suites that only need a provider to exist. */
export const defaultModelsWrapper = modelsWrapper(
  modelsApi({ status: modelStatus(registryRows()) }),
);
