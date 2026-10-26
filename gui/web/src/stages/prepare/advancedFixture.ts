import type { AdvancedGroup, AdvancedStep } from "./AdvancedSteps";

const LANGUAGES = [
  { value: "auto", label: "Detect automatically" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "nl", label: "Dutch" },
] as const;

export const TRANSCRIBE: AdvancedStep = {
  id: "transcribe",
  name: "Transcribe each track",
  result: "3 speakers, 2 hours of audio",
  optional: false,
  enabled: true,
  params: [
    {
      kind: "language",
      id: "language",
      label: "Language",
      help: "What the speakers talk in. Detect automatically works for most shows.",
      value: "auto",
      defaultValue: "auto",
      options: LANGUAGES,
    },
  ],
};

export const ALIGN: AdvancedStep = {
  id: "align",
  name: "Line up tracks",
  result: "Guest track moved 4.2 seconds",
  optional: false,
  enabled: true,
  params: [
    {
      kind: "scrub",
      id: "max-move",
      label: "Largest move",
      help: "The most a track may move to line up. Bigger moves ask you first.",
      value: 5,
      defaultValue: 5,
      min: 1,
      max: 30,
      step: 1,
      unit: ["second", "seconds"],
    },
  ],
};

export const FILL_GAPS: AdvancedStep = {
  id: "fill-gaps",
  name: "Fill gaps from the recorder's noise gate",
  result: "12 gaps filled",
  optional: true,
  enabled: true,
  params: [
    {
      kind: "scrub",
      id: "longest-gap",
      label: "Longest gap to fill",
      help: "Gaps longer than this stay silent.",
      value: 2,
      defaultValue: 1,
      min: 1,
      max: 10,
      step: 1,
      unit: ["second", "seconds"],
    },
  ],
};

export const FILLERS: AdvancedStep = {
  id: "fillers",
  name: "Find fillers and pauses",
  result: "41 fillers, 18 long pauses",
  optional: true,
  enabled: false,
  params: [
    {
      kind: "scrub",
      id: "shortest-pause",
      label: "Shortest pause to flag",
      help: "Pauses shorter than this are left alone.",
      value: 0.8,
      defaultValue: 0.8,
      min: 0.3,
      max: 3,
      step: 0.1,
      unit: ["second", "seconds"],
    },
  ],
};

/** Only the steps the spec maps to the Getting ready rows. */
export const GROUPS: readonly AdvancedGroup[] = [
  { id: "transcribe", title: "Transcribe", steps: [TRANSCRIBE] },
  { id: "line-up", title: "Line up tracks", steps: [ALIGN] },
  { id: "clean", title: "Clean and level", steps: [FILL_GAPS] },
  { id: "suggest", title: "Find suggestions", steps: [FILLERS] },
];

export const RUNNING = {
  title: "Line up tracks",
  detail: "Checking track 2 of 3",
  progress: 0.45,
};
