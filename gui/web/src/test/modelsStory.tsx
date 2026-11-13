import type { Decorator } from "@storybook/react-vite";
import type { ModelState, ModelView, WhisperChoice } from "../models/types";
import { type ModelsApi, ModelsContext } from "../models/useModels";

const WHISPER: WhisperChoice = {
  variant: "large-v3-turbo",
  variants: [
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
  ],
  choose: () => undefined,
};

/** The four registry rows as a fresh machine reports them, with one state override per id. */
export function registryModels(
  states: Partial<Record<string, ModelState>> = {},
): ModelView[] {
  const row = (
    id: string,
    over: Omit<ModelView, "id" | "state">,
  ): ModelView => ({ id, state: states[id] ?? { kind: "missing" }, ...over });
  return [
    row("whisper", {
      label: "Whisper",
      purpose: "transcription",
      tier: "required",
      size: "~1.6 GB",
      sizeBytes: 1_600_000_000,
      variant: "large-v3-turbo",
    }),
    row("rnnoise", {
      label: "Noise reduction (RNNoise)",
      purpose: "noise reduction",
      tier: "recommended",
      size: "~0.3 MB",
      sizeBytes: 297_646,
      variant: null,
    }),
    row("word-aligner", {
      label: "Word aligner",
      purpose: "precise word boundaries",
      tier: "recommended",
      size: "~360 MB",
      sizeBytes: 360_000_000,
      variant: "wav2vec2",
    }),
    row("speaker-ecapa", {
      label: "Speaker model",
      purpose: "speaker recognition and split",
      tier: "recommended",
      size: "~80 MB",
      sizeBytes: 80_000_000,
      variant: null,
    }),
  ];
}

export const UNSUPPORTED_TOOLS = {
  ffmpeg: "unsupported" as const,
  hint: "ShareCut can't process audio on this device yet.",
};

/** The registry rows on a device that cannot run any of them. */
export function unsupportedModels(): ModelView[] {
  const hint = "ShareCut can't transcribe audio on this device yet.";
  return registryModels().map((m) => ({
    ...m,
    state: { kind: "unsupported", hint },
  }));
}

function storyModelsApi(over: Partial<ModelsApi> = {}): ModelsApi {
  const models = over.models === undefined ? registryModels() : over.models;
  const api: ModelsApi = {
    models,
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
    downloads: (models ?? []).filter((m) =>
      ["queued", "downloading", "failed"].includes(m.state.kind),
    ),
    observation: {
      kind: models === null ? "checking" : "current",
      generation: 1,
    },
    tools: { ffmpeg: "installed", hint: null },
    ready: models?.every((m) => m.state.kind === "installed") ?? false,
    busy: false,
    loadError: null,
    whisper: WHISPER,
    download: () => Promise.resolve({ kind: "ok" }),
    cancel: () => Promise.resolve(),
    remove: () => Promise.resolve({ kind: "ok" }),
    refresh: () => Promise.resolve(),
    ...over,
  };
  return api;
}

export const withModels: Decorator = (Story, context) => (
  <ModelsContext.Provider
    value={storyModelsApi(context.parameters.models as Partial<ModelsApi>)}
  >
    <Story />
  </ModelsContext.Provider>
);
