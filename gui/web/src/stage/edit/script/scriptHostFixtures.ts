import type {
  CombinedUtterance,
  ProjectView,
  TrackView,
  TranscriptWordView,
} from "../../../types/project";

/**
 * Story projects for the Script host. The first turn of the base episode (test/episodeFixture, which the story passes in) is Mira's
 * "Welcome back to After Hours Almanac, the show for people who work nights."
 * and each turn starts 4 s after the last. These are plain project views that
 * the story hydrates into the real store; nothing here is test machinery, and
 * no shipped file imports it.
 */

/** Inside Mira's first turn, on "After" (the turn runs 0 to 3.6 s). */
export const PLAYHEAD_SEC = 1.4;

/** The same episode with its two tracks on one speaker split, so the speaker popover has a sibling lane. */
export function splitLanesEpisode(base: ProjectView): ProjectView {
  const tracks: TrackView[] = base.tracks.map((track) => ({
    ...track,
    speaker_split_id: "split-1",
  }));
  return { ...base, tracks };
}

/** Words are still being fetched: the host shows the loading skeleton. */
export function loadingEpisode(base: ProjectView): ProjectView {
  return {
    ...base,
    meta: {
      ...base.meta,
      hydration: { ...base.meta.hydration, transcript_words: false },
    },
  };
}

/** No transcript yet: the host shows the Cover with Transcribe. */
export function noTranscriptEpisode(base: ProjectView): ProjectView {
  return { ...base, transcript: { utterances: [] } };
}

const SENTENCES = [
  "Let us walk through the next part of the night shift",
  "I remember the quiet hours more than the busy ones",
  "There was always one more loaf waiting for the oven",
  "Nobody phoned and the radio hummed along in the corner",
  "We never did learn the name of the woman on the air",
  "The harbor depot had its own rhythm and its own rules",
];

/** Where the long transcript puts its unsure words, one in every 17th turn. */
const UNSURE_EVERY = 17;

function word(
  text: string,
  index: number,
  start: number,
  unsure: boolean,
): TranscriptWordView {
  return {
    text,
    word_index: index,
    start,
    end: start + 0.3,
    timeline_start: start,
    timeline_end: start + 0.3,
    confidence: unsure ? 0.42 : 0.96,
    unsure,
    mappable: true,
  };
}

/** A long run of alternating turns, enough that the host windows them. */
export function longUtterances(turns = 420): CombinedUtterance[] {
  const next: Record<string, number> = {};
  return Array.from({ length: turns }, (_, turn) => {
    const track = turn % 2 === 0 ? "mira-voice" : "tomas-voice";
    const speaker = turn % 2 === 0 ? "Mira" : "Tomas";
    const texts = SENTENCES[turn % SENTENCES.length].split(" ");
    const start = turn * 4;
    const words = texts.map((text, i) => {
      const index = next[track] ?? 0;
      next[track] = index + 1;
      return word(
        text,
        index,
        start + i * 0.3,
        turn % UNSURE_EVERY === 0 && i === 3,
      );
    });
    return {
      track_id: track,
      source_id: null,
      speaker,
      start,
      end: start + texts.length * 0.3,
      text: texts.join(" "),
      timeline_start: start,
      timeline_end: start + texts.length * 0.3,
      mappable: true,
      words,
    };
  });
}

export function longEpisode(base: ProjectView, turns = 420): ProjectView {
  return { ...base, transcript: { utterances: longUtterances(turns) } };
}
