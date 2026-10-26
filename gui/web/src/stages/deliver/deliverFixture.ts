import {
  type Chapter,
  type Clip,
  clipFiles,
  type EpisodeSettings,
  type ExportRequest,
  type ExportState,
  estimateBytes,
  partSeconds,
  type ReadinessFacts,
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
    start: 612,
    end: 653,
    score: 0.82,
    approved: false,
  },
  {
    id: "k2",
    title: "The boat was still there",
    start: 1840,
    end: 1868,
    score: 0.55,
    approved: false,
  },
  {
    id: "k3",
    title: "Cold open",
    start: 0,
    end: 33,
    score: 0.31,
    approved: true,
  },
];

export const REQUEST: ExportRequest = {
  settings: SETTINGS,
  clips: [{ id: "k3", start: 0, end: 33, title: "Cold open" }],
  chapters: CHAPTERS,
  range: null,
};

/** The finished export a host would report for a request. */
export function exportedState(
  request: ExportRequest,
  phase: "done" | "stale" = "done",
): Extract<ExportState, { phase: "done" | "stale" }> {
  const seconds = partSeconds(request.settings.part, TOTAL);
  return {
    phase,
    when: "2 h ago",
    exported: request,
    files: [
      ...request.settings.formats.map((id) => ({
        name: `field-notes.${id}`,
        bytes: estimateBytes(id, seconds),
        format: id,
      })),
      ...clipFiles(
        request.clips.map((c) => ({ ...c, score: 1, approved: true })),
      ),
    ],
  };
}

export const NEVER: ExportState = { phase: "never" };
export const RUNNING: ExportState = {
  phase: "running",
  progress: 0.6,
  detail: "Mastering · Writing MP3 · 60%",
};
export const DONE = exportedState(REQUEST);
export const STALE = exportedState(REQUEST, "stale");
export const NEEDS_MODEL: ExportState = {
  phase: "needs-model",
  model: "transcription model",
  size: "1.6 GB",
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
