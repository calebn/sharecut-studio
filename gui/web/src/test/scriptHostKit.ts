import { useDawStore } from "../state/dawStore";
import type {
  CombinedUtterance,
  ProjectView,
  TranscriptWordView,
} from "../types/project";
import { minimalProject, sampleTrack } from "./fixtures";

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

export type ScriptSeed = {
  projectPath?: string;
  guestMode?: string | null;
  shareCapabilities?: string[] | null;
  utterances?: CombinedUtterance[];
  project?: Partial<ProjectView>;
  playheadSec?: number;
  transcriptFollowPlayhead?: boolean;
};

/** Put a two-speaker transcript in the real store. */
export function seedScript(seed: ScriptSeed = {}) {
  useDawStore.setState({
    projectPath: seed.projectPath ?? "/tmp/ep",
    guestMode: seed.guestMode ?? null,
    shareCapabilities: seed.shareCapabilities ?? null,
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
  });
}
