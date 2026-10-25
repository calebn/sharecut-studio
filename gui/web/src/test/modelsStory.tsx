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
      tier: "offered",
      size: "~360 MB",
      sizeBytes: null,
      variant: "wav2vec2",
    }),
    row("speaker-ecapa", {
      label: "Speaker model",
      purpose: "speaker recognition and split",
      tier: "offered",
      size: "~25 MB",
      sizeBytes: null,
      variant: null,
    }),
  ];
}

export function storyModelsApi(over: Partial<ModelsApi> = {}): ModelsApi {
  const models = over.models === undefined ? registryModels() : over.models;
  return {
    models,
    tools: { ffmpeg: "installed", hint: null },
    ready: models?.every((m) => m.state.kind === "installed") ?? false,
    busy: false,
    loadError: null,
    whisper: WHISPER,
    download: () => Promise.resolve({ kind: "ok" }),
    cancel: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    ...over,
  };
}

/** Provides the models context a live component reads, from `parameters.models`. */
export const withModels: Decorator = (Story, context) => (
  <ModelsContext.Provider
    value={storyModelsApi(context.parameters.models as Partial<ModelsApi>)}
  >
    <Story />
  </ModelsContext.Provider>
);
