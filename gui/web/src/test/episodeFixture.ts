import type { RecordSnapshot } from "../record/types";
import type { PipelineJobSnapshot } from "../types/pipeline";
import {
  type ChapterMarker,
  type ClipRow,
  type CombinedUtterance,
  HISTORY_ROOT_ID,
  type HistoryEntryId,
  type HistoryGroup,
  type ProjectView,
  type Selection,
  type SocialClipView,
  type TrackView,
} from "../types/project";
import {
  appliedEditRecord,
  COMMENTER_CAPABILITIES,
  clipRow,
  minimalProject,
  pendingEditView,
  pipelineJobSnapshot,
  recordParticipant,
  recordSnapshot,
  sampleComment,
  sampleTrack,
} from "./fixtures";

export const MIRA = "mira-voice";
export const TOMAS = "tomas-voice";

const TURN_SEC = 4;
const SPOKEN_SEC = 3.6;

const SCRIPT: readonly (readonly [string, string])[] = [
  [
    MIRA,
    "Welcome back to After Hours Almanac, the show for people who work nights.",
  ],
  [
    TOMAS,
    "Thanks for having me, I have not slept properly in about nine years.",
  ],
  [MIRA, "Let's start at the beginning. What was your first overnight shift?"],
  [TOMAS, "A bakery on Alder Street, four in the morning, flour everywhere."],
  [MIRA, "And you stayed for how long?"],
  [TOMAS, "Um, three winters, maybe four, I lost count honestly."],
  [MIRA, "What did the owner teach you that school never did?"],
  [TOMAS, "That a loaf tells you when it is ready, you just have to listen."],
  [MIRA, "That sounds almost like a podcast rule."],
  [TOMAS, "Ha, it is the same rule, wait until the thing is finished talking."],
  [MIRA, "Tell me about the radio in the corner."],
  [TOMAS, "It only got one station, a night program with a gentle host."],
  [MIRA, "Did you ever meet her?"],
  [TOMAS, "Never, but I wrote her a letter once and she read it on air."],
  [MIRA, "What did the letter say?"],
  [TOMAS, "Just that somebody was awake, and that it helped."],
  [MIRA, "Let's talk about the move to the harbor depot."],
  [TOMAS, "Different crowd, forklifts instead of ovens, same quiet hours."],
  [MIRA, "Was it lonelier?"],
  [TOMAS, "Louder, actually, but lonelier too, yes."],
  [MIRA, "How did you keep a sleep schedule?"],
  [TOMAS, "Blackout curtains, a fan, and a very strict rule about screens."],
  [MIRA, "Did the rule hold?"],
  [TOMAS, "Mostly, until the season finale of anything."],
  [MIRA, "What about your family?"],
  [
    TOMAS,
    "My sister sends voice notes timed for my lunch, which is her breakfast.",
  ],
  [MIRA, "That is lovely."],
  [TOMAS, "It is how we stayed close, one little recording at a time."],
  [MIRA, "Let's take a short break and come back to that."],
  [TOMAS, "Sure, I will find some water."],
  [MIRA, "We are back, and I want to ask about the strangest night."],
  [TOMAS, "A power cut, the whole depot dark, and everybody started singing."],
  [MIRA, "Nobody planned it?"],
  [TOMAS, "Nobody planned anything, that was the point."],
  [MIRA, "What would you tell someone starting nights today?"],
  [
    TOMAS,
    "Protect your morning, it is the only part of the day that is yours.",
  ],
  [MIRA, "Where can people find your writing?"],
  [
    TOMAS,
    "On my site, and in a small newsletter called Flour and Fluorescent.",
  ],
  [MIRA, "Thank you for staying up with us."],
  [TOMAS, "Thank you, and good morning to everyone listening."],
];

const LOW_CONFIDENCE = new Set(["maybe", "um,", "Flour"]);

function buildUtterances(): CombinedUtterance[] {
  const nextWordIndex: Record<string, number> = { [MIRA]: 0, [TOMAS]: 0 };
  return SCRIPT.map(([trackId, text], turn) => {
    const start = turn * TURN_SEC;
    const words = text.split(" ");
    const step = SPOKEN_SEC / words.length;
    return {
      track_id: trackId,
      source_id: null,
      speaker: trackId === MIRA ? "Mira" : "Tomas",
      start,
      end: start + SPOKEN_SEC,
      text,
      mappable: true,
      timeline_start: start,
      timeline_end: start + SPOKEN_SEC,
      words: words.map((word, index) => {
        const wordStart = start + index * step;
        return {
          text: word,
          start: wordStart,
          end: wordStart + step,
          timeline_start: wordStart,
          timeline_end: wordStart + step,
          word_index: nextWordIndex[trackId]++,
          confidence: LOW_CONFIDENCE.has(word) ? 0.42 : 0.96,
          mappable: true,
        };
      }),
    };
  });
}

export const EPISODE_DURATION_SEC = SCRIPT.length * TURN_SEC;

function buildClips(): Record<string, ClipRow[]> {
  return Object.fromEntries(
    [MIRA, TOMAS].map((trackId) => [
      trackId,
      [
        clipRow({
          id: `clip-${trackId}`,
          track_id: trackId,
          source_end: EPISODE_DURATION_SEC,
          timeline_end: EPISODE_DURATION_SEC,
          source_duration_sec: EPISODE_DURATION_SEC,
          recording_key: `${trackId}-take-1`,
        }),
      ],
    ]),
  );
}

const TRACKS: TrackView[] = [
  sampleTrack({
    id: MIRA,
    label: "Mira",
    speaker: "Mira",
    duration_sec: EPISODE_DURATION_SEC,
  }),
  sampleTrack({
    id: TOMAS,
    label: "Tomas",
    speaker: "Tomas",
    duration_sec: EPISODE_DURATION_SEC,
  }),
];

const CHAPTERS: ChapterMarker[] = [
  { time: 0, title: "Cold open" },
  { time: 64, title: "The harbor depot" },
  { time: 124, title: "Protect your morning" },
];

const SOCIAL_CLIPS: SocialClipView[] = [
  {
    id: "social-1",
    track_id: TOMAS,
    start: 28,
    end: 44,
    score: 0.87,
    title_suggestion: "A loaf tells you when it is ready",
    approved: false,
    review_required: true,
  },
];

function entryId(value: string): HistoryEntryId {
  return value as HistoryEntryId;
}

const HISTORY_GROUPS: HistoryGroup[] = [
  {
    kind: "mutation",
    operation: "remove",
    title: "Cut 20.4 to 21.2 s on Mira",
    created_at: "2026-01-01T09:00:00Z",
    before_id: "h0",
    after_id: "h1",
    before_index: 0,
    after_index: 1,
  },
  {
    kind: "mutation",
    operation: "add_chapter",
    title: "Add chapter The harbor depot",
    created_at: "2026-01-01T09:05:00Z",
    before_id: "h1",
    after_id: "h2",
    before_index: 1,
    after_index: 2,
  },
  {
    kind: "mutation",
    operation: "correct_word",
    title: "Correct a word on Tomas",
    created_at: "2026-01-01T09:10:00Z",
    before_id: "h2",
    after_id: "h3",
    before_index: 2,
    after_index: 3,
  },
];

const APPLIED = appliedEditRecord({
  id: "applied-1",
  track_ids: [MIRA],
  timeline_start: 20.4,
  timeline_end: 21.2,
  source_start: 20.4,
  source_end: 21.2,
  reason: "Trim the false start",
});

const PENDING = pendingEditView({
  id: "pending-1",
  track_id: MIRA,
  track_ids: [MIRA],
  reason: "Shorten the pause",
  source_start: 40.6,
  source_end: 41.4,
  source_start_timeline: 40.6,
  source_end_timeline: 41.4,
  timeline_start: 40.6,
  timeline_end: 41.4,
  timeline_spans: [{ start: 40.6, end: 41.4 }],
  cut_confidence: 0.78,
  label: "Pause",
  suggested_action: "shorten",
});

const COMMENTS = [
  sampleComment({
    id: "comment-1",
    body: "Can we trim the pause before this answer?",
    author: "Ines",
    timeline_start: 40.6,
    timeline_end: 41.4,
    track_ids: [MIRA],
    action_items: [
      {
        id: "action-1",
        text: "Review the cut",
        done: false,
        completed_at: null,
        completed_by: null,
      },
    ],
    replies: [
      {
        id: "reply-1",
        body: "Looking at it now.",
        author: "Mira",
        created_at: "2026-01-01T10:00:00Z",
      },
    ],
  }),
  sampleComment({
    id: "comment-2",
    body: "Great story, keep it all.",
    author: "Ines",
    timeline_start: 28,
    timeline_end: null,
    track_ids: [TOMAS],
  }),
  sampleComment({
    id: "comment-3",
    body: "Fixed the spelling of the newsletter name.",
    author: "Ines",
    timeline_start: 140,
    timeline_end: null,
    track_ids: [TOMAS],
    resolved: true,
    resolved_at: "2026-01-01T11:00:00Z",
    resolved_by: "Mira",
  }),
];

export function episode(overrides: Partial<ProjectView> = {}): ProjectView {
  return minimalProject({
    project_path: "/episodes/after-hours/episode.project.json",
    meta: {
      name: "After Hours Almanac 12",
      workspace_dir: "/episodes/after-hours",
    },
    timeline_duration_sec: EPISODE_DURATION_SEC,
    tracks: TRACKS,
    clips: { tracks: buildClips(), clip_count: TRACKS.length },
    chapters: CHAPTERS,
    pending_edits: [PENDING],
    applied_edits: { count: 1, records: [APPLIED] },
    envelopes: [
      {
        track_id: MIRA,
        parameter: "volume",
        points: [
          { id: "point-1", time: 0, value: 0 },
          { id: "point-2", time: 30, value: -3 },
          { id: "point-3", time: EPISODE_DURATION_SEC, value: 0 },
        ],
      },
    ],
    social_clips: SOCIAL_CLIPS,
    comments: COMMENTS,
    edit_impact: {
      pending_review_count: 1,
      total_removed_sec: 0.8,
      by_track_sec: { [MIRA]: 0.8 },
    },
    history: {
      cursor: HISTORY_GROUPS.length,
      head_id: entryId("h3"),
      can_undo: true,
      can_redo: false,
      groups: HISTORY_GROUPS,
    },
    transcript: { utterances: buildUtterances() },
    ...overrides,
  });
}

/** An episode with nothing to review, for empty-state stories. */
export function emptyEpisode(): ProjectView {
  return episode({
    pending_edits: [],
    applied_edits: { count: 0, records: [] },
    edit_impact: {
      pending_review_count: 0,
      total_removed_sec: 0,
      by_track_sec: {},
    },
    comments: [],
    social_clips: [],
    chapters: [],
    history: {
      cursor: 0,
      head_id: HISTORY_ROOT_ID,
      can_undo: false,
      can_redo: false,
      groups: [],
    },
  });
}

export const selections = {
  none: null,
  clip: { kind: "clip", id: `clip-${MIRA}`, trackId: MIRA },
  pendingEdit: { kind: "pending", id: "pending-1", trackId: MIRA },
  appliedEdit: { kind: "applied", id: "applied-1", trackId: MIRA },
  track: { kind: "track", trackId: MIRA },
  chapter: { kind: "chapter", id: "The harbor depot", time: 64 },
  social: { kind: "social", id: "social-1" },
  comment: { kind: "comment", id: "comment-1" },
  word: {
    kind: "transcriptRange",
    trackId: MIRA,
    sourceId: null,
    startWordIndex: 3,
    endWordIndex: 3,
  },
  range: {
    kind: "transcriptRange",
    trackId: MIRA,
    sourceId: null,
    startWordIndex: 3,
    endWordIndex: 6,
  },
  exactRange: {
    kind: "range",
    target: {
      kind: "exact_range",
      intervals: [{ start: 8, end: 12 }],
      track_ids: [MIRA],
      clips: [],
      media_seals: {},
    },
  },
} as const satisfies Record<string, Selection>;

export const pipelineJob: PipelineJobSnapshot = pipelineJobSnapshot({
  id: "job-1",
  project_path: "/episodes/after-hours/episode.project.json",
  message: "Cleaning up dialogue",
  current: 2,
  total: 6,
  elapsed_sec: 31,
});

export const recordRoom: RecordSnapshot = recordSnapshot({
  participants: [
    recordParticipant({
      participant_id: "host-1",
      role: "host",
      display_name: "Mira",
    }),
    recordParticipant({
      participant_id: "guest-1",
      display_name: "Tomas",
    }),
  ],
});

export type EpisodeRole = "host" | "viewer" | "commenter" | "editor";

/** `guest_mode` and capabilities the server sends for each role; the host has neither. */
export const ROLE_SHARE: Record<
  EpisodeRole,
  { guestMode: string | null; capabilities: string[] | null }
> = {
  host: { guestMode: null, capabilities: null },
  viewer: { guestMode: "view", capabilities: ["play", "view"] },
  commenter: { guestMode: "comment", capabilities: COMMENTER_CAPABILITIES },
  editor: {
    guestMode: "edit",
    capabilities: [...COMMENTER_CAPABILITIES, "edit"],
  },
};
