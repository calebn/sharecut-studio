/**
 * The host's speech guard, client side: a ripple that would cut another
 * track's speech changes nothing and replies `needs_confirmation`. The person
 * then chooses Cut anyway (resubmit confirmed) or Leave a gap (resubmit in gap
 * mode), so a guarded ripple never does nothing silently.
 */

export type CutSpeechSpan = Readonly<{ start: number; end: number }>;

export type CutSpeechWord = Readonly<{
  text: string;
  timeline_start: number;
  timeline_end: number;
}>;

/** One other track's speech inside the removed time, on the timeline clock. */
export type CutSpeechTrack = Readonly<{
  track_id: string;
  speaker: string;
  words: readonly CutSpeechWord[];
  /** Speech-level sound with no transcript words. */
  sound_spans: readonly CutSpeechSpan[];
}>;

export type CutSpeech = Readonly<{
  spans: readonly CutSpeechSpan[];
  tracks: readonly CutSpeechTrack[];
}>;

/** The two ways forward from a refused ripple; `leaveGap` is null when the edit has no gap form (approving a suggestion). */
export type CutSpeechChoices = Readonly<{
  cutAnyway: () => Promise<unknown>;
  leaveGap: (() => Promise<unknown>) | null;
}>;

export type CutSpeechPrompt = CutSpeechChoices &
  Readonly<{ projectPath: string; speech: CutSpeech }>;

/** What a rippling command did: applied, saved for later, or waiting on the person. */
export type RippleOutcome = Readonly<{ queued: boolean; asked: boolean }>;

export function cutSpeechOf(result: Record<string, unknown>): CutSpeech | null {
  const ask = result.needs_confirmation;
  if (typeof ask !== "object" || ask === null) return null;
  const speech = (ask as { speech?: unknown }).speech;
  if (typeof speech !== "object" || speech === null) return null;
  const { spans, tracks } = speech as Partial<CutSpeech>;
  return Array.isArray(spans) && Array.isArray(tracks) && tracks.length > 0
    ? { spans, tracks }
    : null;
}

/** Where this track's speech in the cut starts. */
export function firstSpeechSec(track: CutSpeechTrack): number {
  return Math.min(
    ...track.words.map((w) => w.timeline_start),
    ...track.sound_spans.map((s) => s.start),
  );
}

/** Speakers in the order their speech starts, one entry each. */
export function cutSpeakers(speech: CutSpeech): string[] {
  const ordered = [...speech.tracks].sort(
    (a, b) => firstSpeechSec(a) - firstSpeechSec(b),
  );
  return [...new Set(ordered.map((t) => t.speaker))];
}

/** "Avery", "Avery and Sam", "Avery, Sam and Lee". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
