import { PEOPLE, VOICE_PEAKS } from "../../system/prepareFixtures";
import type { PrepareSession, PrepareSource } from "./prepareTypes";
import type { ReadyRowData } from "./ReadyList";

const take = (
  id: string,
  name: string,
  fileName: string,
  audioTime: string,
  state: PrepareSource["state"] = "ready",
  extra: Partial<PrepareSource> = {},
): PrepareSource => ({
  id,
  state,
  name,
  fileName,
  audioTime,
  peaks: VOICE_PEAKS,
  ...extra,
});

export const NAMED_TAKES: readonly PrepareSource[] = [
  take("maya", "Maya", "maya.wav", "14:20 of audio"),
  take("anneke", "Anneke", "anneke.wav", "13:58 of audio"),
  take("joss", "Joss", "joss.wav", "6:02 of audio"),
];

/** Maya, Anneke and Joss already ran; Priya's file was added after. */
export const TAKES_WITH_NEW: readonly PrepareSource[] = [
  ...NAMED_TAKES,
  take("priya", "Priya", "priya.wav", "14:11 of audio", "new"),
];

/** The same four takes once the run has processed Priya's. */
export const TAKES_PROCESSED: readonly PrepareSource[] = [
  ...NAMED_TAKES,
  take("priya", "Priya", "priya.wav", "14:11 of audio"),
];

export const UNNAMED_TAKES: readonly PrepareSource[] = [
  take("t1", "", "track-1.wav", "14:20 of audio", "needs-name"),
  take("t2", "", "track-2.wav", "13:58 of audio", "needs-name"),
  take("t3", "", "track-3.wav", "6:02 of audio", "needs-name"),
];

/** Three files, still going up or being checked. */
export const IMPORTING_TAKES: readonly PrepareSource[] = [
  take("u1", "", "track-1.wav", "", "uploading", { progress: 0.62 }),
  take("u2", "", "track-2.wav", "", "probing"),
  take("u3", "", "track-3.wav", "", "probing"),
];

export function session(
  overrides: Partial<PrepareSession> = {},
): PrepareSession {
  return {
    id: "s1",
    title: "Session 1 · 25 Oct",
    people: 3,
    takes: 3,
    duration: "14:20",
    target: "end",
    status: "idle",
    sources: NAMED_TAKES,
    ...overrides,
  };
}

export const SECOND_SESSION: PrepareSession = session({
  id: "s2",
  title: "Session 2 · 2 Nov",
  people: 2,
  takes: 2,
  duration: "9:41",
  status: "running",
  progress: 0.35,
  sources: [
    take("m2", "Maya", "maya-2.wav", "9:41 of audio"),
    take("a2", "Anneke", "anneke-2.wav", "9:30 of audio"),
  ],
});

const ADD_DONE: ReadyRowData = {
  id: "add",
  state: "done",
  title: "Add audio",
  detail: "3 files",
};
const TRANSCRIBE_RUNNING: ReadyRowData = {
  id: "transcribe",
  state: "running",
  title: "Transcribe",
  detail: "2 of 3 speakers · about 1 min left",
  progress: 0.6,
};
const QUEUED = (
  id: ReadyRowData["id"],
  title: string,
  detail?: string,
): ReadyRowData => ({ id, state: "queued", title, detail });

const ALIGN: ReadyRowData = QUEUED("align", "Line up tracks");
const CLEAN: ReadyRowData = QUEUED("clean", "Clean and level");
const SUGGEST: ReadyRowData = QUEUED("suggest", "Find suggestions");

const planRow = (
  id: ReadyRowData["id"],
  title: string,
  detail: string,
): ReadyRowData => ({
  id,
  state: "queued",
  title,
  detail,
  action: { label: "Skip", run: "skip" },
});

export const ROWS = {
  queued: [
    ADD_DONE,
    QUEUED("transcribe", "Transcribe", "Starts in a moment"),
    ALIGN,
    CLEAN,
    SUGGEST,
  ],
  importing: [
    {
      id: "add",
      state: "running",
      title: "Add audio",
      detail: "1 of 3 files",
      progress: 0.4,
    },
    QUEUED("transcribe", "Transcribe"),
    ALIGN,
    CLEAN,
    SUGGEST,
  ],
  running: [ADD_DONE, TRANSCRIBE_RUNNING, ALIGN, CLEAN, SUGGEST],
  alignCheck: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "done",
      title: "Transcribe",
      detail: "3 speakers",
    },
    {
      id: "align",
      state: "needs-you",
      title: "Line up tracks",
      detail: "Guest track moved 4.2 s to line up",
      body: {
        kind: "align",
        text: "Listen to the move. Keep it, or put the track back where it was.",
      },
    },
    { id: "clean", state: "running", title: "Clean and level", progress: 0.3 },
    SUGGEST,
  ],
  needsModel: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "needs-you",
      title: "Transcribe",
      detail: "Needs a 1.6 GB download first.",
      action: {
        label: "Get (1.6 GB)",
        icon: "cloud-download",
        run: "download-model",
      },
    },
    ALIGN,
    { id: "clean", state: "running", title: "Clean and level", progress: 0.45 },
    SUGGEST,
  ],
  modelDownloading: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "running",
      title: "Transcribe",
      detail: "Downloading the transcription model",
      progress: 0.4,
    },
    ALIGN,
    { id: "clean", state: "running", title: "Clean and level", progress: 0.45 },
    SUGGEST,
  ],
  keepFixes: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "needs-you",
      title: "Transcribe",
      detail: "You fixed 12 words",
      body: {
        kind: "keep-fixes",
        text: "Transcribing again would change words you fixed by hand. Keep them, or replace them with the new transcript.",
      },
    },
    ALIGN,
    CLEAN,
    SUGGEST,
  ],
  failed: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "failed",
      title: "Transcribe",
      detail: "Not enough memory to finish",
      action: { label: "Try again", run: "try-again" },
      details:
        "The computer ran out of memory while it listened to the longest track. Close other apps and try again. The full log is in the Help bundle.",
    },
    ALIGN,
    CLEAN,
    SUGGEST,
  ],
  done: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "done",
      title: "Transcribe",
      detail: "3 speakers",
    },
    {
      id: "align",
      state: "done",
      title: "Line up tracks",
      detail: "No moves needed",
    },
    {
      id: "clean",
      state: "done",
      title: "Clean and level",
      detail: "Noise, volume, balance",
    },
    {
      id: "suggest",
      state: "done",
      title: "Find suggestions",
      detail: "14 suggestions",
    },
  ],
  /** The plan for audio added after a run: nothing has started. */
  plan: [
    {
      id: "add",
      state: "done",
      title: "Add audio",
      detail: "Priya added, 1 file",
    },
    planRow("transcribe", "Transcribe", "Priya only · 3 kept"),
    planRow("align", "Line up tracks", "All 4 tracks, Priya joins"),
    planRow("clean", "Clean and level", "All 4 tracks"),
    planRow("suggest", "Find suggestions", "Whole episode"),
  ],
  /** The same plan with Line up tracks skipped for this run. */
  planSkipped: [
    {
      id: "add",
      state: "done",
      title: "Add audio",
      detail: "Priya added, 1 file",
    },
    planRow("transcribe", "Transcribe", "Priya only · 3 kept"),
    {
      id: "align",
      state: "queued",
      title: "Line up tracks",
      detail: "Skipped this time. Priya is not lined up with the others.",
      action: { label: "Include", run: "include" },
    },
    planRow("clean", "Clean and level", "All 4 tracks"),
    planRow("suggest", "Find suggestions", "Whole episode"),
  ],
  /** After a run that reused earlier results. */
  reused: [
    { id: "add", state: "done", title: "Add audio", detail: "4 files" },
    {
      id: "transcribe",
      state: "done",
      title: "Transcribe",
      detail: "1 new · 3 reused",
    },
    {
      id: "align",
      state: "done",
      title: "Line up tracks",
      detail: "No moves needed",
    },
    {
      id: "clean",
      state: "done",
      title: "Clean and level",
      detail: "1 new · 3 reused",
    },
    {
      id: "suggest",
      state: "done",
      title: "Find suggestions",
      detail: "16 suggestions",
    },
  ],
  approximateTiming: [
    ADD_DONE,
    {
      id: "transcribe",
      state: "needs-you",
      title: "Transcribe",
      detail:
        "Transcribed. Word timing is approximate, so cuts may clip word edges.",
      action: {
        label: "Download word timing (360 MB)",
        icon: "cloud-download",
        run: "download-aligner",
      },
    },
    ALIGN,
    { id: "clean", state: "done", title: "Clean and level" },
    SUGGEST,
  ],
} as const satisfies Record<string, readonly ReadyRowData[]>;

export const FAILURE = {
  step: "Transcribing",
  cause: "The computer ran out of memory.",
} as const;

/** Speaker chips for the Vocabulary stories: the people from the Source cards. */
export const SPEAKER_NAMES: readonly string[] = PEOPLE.map(
  (person) => person.name,
);

export const SOME_TERMS: readonly string[] = [
  "Okonkwo-Adeyemi Labs",
  "Tessellate Systems",
  "Quetzalcoatlus",
];

/** Enough terms to leave 25 of the 372 characters: the count shows. */
export const NEAR_LIMIT_TERMS: readonly string[] = [
  "Okonkwo-Adeyemi Labs",
  "Tessellate Systems",
  "Bioluminescence",
  "Quetzalcoatlus",
  "Chiaroscuro Press",
  "Hyperion Cantos",
  "Mnemosyne Archive",
  "Ouroboros Engine",
  "Phosphorescent Co",
  "Zeitgeber Clock",
  "Saccharomyces",
  "Lindisfarne Gospels",
  "Vantablack Studio",
  "Heliopause Radio",
  "Mediterranean Cartographers",
  "Interstellar Fermentation",
];
