import { forgetHeldFixText } from "../stage/edit/script/useScriptFixText";
import { useDawStore } from "../state/dawStore";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type {
  CombinedUtterance,
  ProjectView,
  TranscriptWordView,
} from "../types/project";
import { clipRow, minimalProject, sampleTrack } from "./fixtures";

/** A timed word on the timeline (source and timeline times agree). */
export function scriptWord(
  text: string,
  wordIndex: number,
  start: number,
  extra: Partial<TranscriptWordView> = {},
): TranscriptWordView {
  return {
    text,
    word_index: wordIndex,
    start,
    end: start + 0.4,
    timeline_start: start,
    timeline_end: start + 0.4,
    mappable: true,
    ...extra,
  };
}

export function scriptUtterance(
  trackId: string,
  speaker: string,
  words: TranscriptWordView[],
  extra: Partial<CombinedUtterance> = {},
): CombinedUtterance {
  return {
    track_id: trackId,
    source_id: null,
    speaker,
    start: words[0]?.start ?? 0,
    end: words[words.length - 1]?.end ?? 0,
    text: words.map((w) => w.text).join(" "),
    timeline_start: words[0]?.timeline_start ?? null,
    timeline_end: words[words.length - 1]?.timeline_end ?? null,
    mappable: true,
    words,
    ...extra,
  };
}

/**
 * Window indices: 0-5 Maya "Welcome back to the show friends" (to is unsure),
 * 6-9 Anneke "Thanks so much Maya", 10-12 Maya "Hello again everyone" (again
 * is unsure), 13 Anneke "mumble" in a bleed-only row (unsure, never counted).
 */
export function scriptUtterances(): CombinedUtterance[] {
  return [
    scriptUtterance("host", "Maya", [
      scriptWord("Welcome", 0, 10),
      scriptWord("back", 1, 10.5),
      scriptWord("to", 2, 11, { unsure: true }),
      scriptWord("the", 3, 11.5),
      scriptWord("show", 4, 12),
      scriptWord("friends", 5, 12.5),
    ]),
    scriptUtterance("guest", "Anneke", [
      scriptWord("Thanks", 0, 14),
      scriptWord("so", 1, 14.5),
      scriptWord("much", 2, 15),
      scriptWord("Maya", 3, 15.5),
    ]),
    scriptUtterance("host", "Maya", [
      scriptWord("Hello", 6, 20),
      scriptWord("again", 7, 20.5, { unsure: true }),
      scriptWord("everyone", 8, 21),
    ]),
    scriptUtterance(
      "guest",
      "Anneke",
      [scriptWord("mumble", 4, 22, { unsure: true, suppressed: true })],
      { suppressed_only: true },
    ),
  ];
}

/** One 30 s clip per lane, host and guest, for drag-selection tests. */
export const TWO_LANE_CLIPS = {
  tracks: {
    host: [
      clipRow({
        id: "ch",
        track_id: "host",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
    guest: [
      clipRow({
        id: "cg",
        track_id: "guest",
        timeline_start: 0,
        timeline_end: 30,
        source_start: 0,
        source_end: 30,
      }),
    ],
  },
  clip_count: 2,
};

export type ScriptSeed = {
  projectPath?: string;
  guestMode?: string | null;
  shareCapabilities?: string[] | null;
  shareTranscriptWords?: boolean;
  utterances?: CombinedUtterance[];
  project?: Partial<ProjectView>;
  playheadSec?: number;
  transcriptFollowPlayhead?: boolean;
};

/** Put a two-speaker transcript in the real store. */
export function seedScript(seed: ScriptSeed = {}) {
  forgetHeldFixText();
  useDawStore.setState({
    projectPath: seed.projectPath ?? "/tmp/ep",
    guestMode: seed.guestMode ?? null,
    shareCapabilities: seed.shareCapabilities ?? null,
    shareTranscriptWords: seed.shareTranscriptWords ?? false,
    project: minimalProject({
      tracks: [
        sampleTrack({ id: "host", speaker: "Maya" }),
        sampleTrack({ id: "guest", speaker: "Anneke" }),
      ],
      transcript: { utterances: seed.utterances ?? scriptUtterances() },
      ...seed.project,
    }),
    selection: null,
    playheadSec: seed.playheadSec ?? 0,
    transcriptFollowPlayhead: seed.transcriptFollowPlayhead ?? false,
    showCutAwayUtterances: false,
    pipelineJob: null,
  });
  useDawStore.getState().setTranscriptFindReplaceOpen(false);
}

/** A live full run on the seeded project: sources added, transcribe_tracks running. */
export function transcribeRun(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "run-1",
    project_path: useDawStore.getState().projectPath ?? "/tmp/ep",
    from_step: null,
    only_step: null,
    status: "running",
    current: 1,
    total: 4,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [
      { name: "ingest_tracks", status: "ok", elapsed_sec: 1, error: null },
      {
        name: "transcribe_tracks",
        status: "running",
        elapsed_sec: 2,
        error: null,
      },
    ],
    ...overrides,
  };
}

/** Turn the transcript's hydration flag on or off in the seeded project. */
export function setTranscriptLoading(loading: boolean) {
  useDawStore.setState((s) => ({
    project: s.project && {
      ...s.project,
      meta: {
        ...s.project.meta,
        hydration: { transcript_words: !loading },
      } as typeof s.project.meta,
    },
  }));
}
