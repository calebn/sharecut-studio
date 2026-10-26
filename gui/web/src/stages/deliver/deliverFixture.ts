import type {
  Chapter,
  Clip,
  EpisodeSettings,
  ExportState,
  ReadinessFacts,
} from "./deliverLogic";

export const TOTAL = 3120;

export const CLEAR_FACTS: ReadinessFacts = {
  suggestions: { decided: 14, total: 14 },
  comments: { resolved: 3, total: 3 },
  unsureWordsLeft: 0,
  mixUpToDate: true,
  loudness: "podcast",
  chapters: 5,
  editsSaved: 23.6,
};

export const OPEN_FACTS: ReadinessFacts = {
  ...CLEAR_FACTS,
  comments: { resolved: 2, total: 3 },
  unsureWordsLeft: 2,
};

export const MEASURED_FACTS: ReadinessFacts = {
  ...CLEAR_FACTS,
  measuredLufs: -16.1,
  truePeak: -2.1,
};

export const SETTINGS: EpisodeSettings = {
  formats: ["mp3", "wav"],
  loudness: "podcast",
  part: { mode: "whole" },
};

export const CHAPTERS: readonly Chapter[] = [
  { id: "c1", at: 0, title: "Cold open" },
  { id: "c2", at: 312.4, title: "The old mill" },
  { id: "c3", at: 1180, title: "What the river wanted" },
  { id: "c4", at: 2410.5, title: "Listener mail" },
];

export const CLIPS: readonly Clip[] = [
  {
    id: "k1",
    title: "Nobody asked the river",
    seconds: 41,
    score: 0.82,
    approved: false,
  },
  {
    id: "k2",
    title: "The boat was still there",
    seconds: 28,
    score: 0.55,
    approved: false,
  },
  { id: "k3", title: "Cold open", seconds: 33, score: 0.31, approved: true },
];

export const FILES = [
  { name: "field-notes.mp3", bytes: 49_900_000, format: "mp3" },
  { name: "field-notes.wav", bytes: 550_000_000, format: "wav" },
] as const;

export const NEVER: ExportState = { phase: "never" };
export const RUNNING: ExportState = {
  phase: "running",
  progress: 0.6,
  detail: "Mastering · Writing MP3 · 60%",
};
export const DONE: ExportState = {
  phase: "done",
  files: FILES,
  when: "2 h ago",
};
export const STALE: ExportState = {
  phase: "stale",
  files: FILES,
  when: "2 h ago",
};
export const FAILED: ExportState = {
  phase: "failed",
  cause: "The disk is full. Free some space and try again.",
};

export const LINK = "https://share.example.app/l/7Hq2mXk9TnP4vLr8Za3w";
export const OPENED_BY = [
  { name: "Rosa", colorIndex: 2 },
  { name: "Jon", colorIndex: 1 },
];
