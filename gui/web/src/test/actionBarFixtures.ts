import { type EditRole, editFacts } from "../edit/editSelection";
import { makeRangeTarget } from "../edit/rangeSelection";
import type { BarItem } from "../system/actionBarSlots";
import {
  type BarId,
  type ResolvedBar,
  resolveBar,
} from "../system/editActionSets";
import type { ScopeTrack } from "../system/ScopeChip";
import type { ProjectView, Selection } from "../types/project";
import {
  appliedEditRecord,
  clipRow,
  minimalProject,
  pendingEditView,
  sampleComment,
  sampleTrack,
} from "./fixtures";

export const MIRA = "mira-voice";
export const JONAS = "jonas-voice";

const mira = (id: string, start: number, end: number) =>
  clipRow({
    id,
    track_id: MIRA,
    source_start: start,
    source_end: end,
    timeline_start: start,
    timeline_end: end,
  });

/** Mira has a gap between her second and third clip and one cut at 2 s to 3 s; Jonas is unbroken. */
export function editFixtureProject(): ProjectView {
  const miraClips = [mira("a", 0, 4), mira("b", 6, 10), mira("c", 12, 14)];
  const jonasClips = [
    clipRow({ id: "j", track_id: JONAS, timeline_end: 14, source_end: 14 }),
  ];
  return minimalProject({
    tracks: [
      sampleTrack({ id: MIRA, label: "Mira", range_media_seal: "m" }),
      sampleTrack({ id: JONAS, label: "Jonas", range_media_seal: "j" }),
    ],
    clips: {
      tracks: { [MIRA]: miraClips, [JONAS]: jonasClips },
      clip_count: 4,
    },
    transcript: {
      utterances: [
        {
          track_id: MIRA,
          speaker: "Mira",
          start: 1,
          end: 8,
          text: "so um this is",
          words: [
            { text: "so", start: 1, end: 2, word_index: 0 },
            {
              text: "um",
              start: 2.5,
              end: 3.5,
              word_index: 1,
              suppressed: true,
            },
            { text: "this", start: 7, end: 8, word_index: 2 },
          ],
        },
      ],
    },
    applied_edits: {
      count: 1,
      records: [appliedEditRecord({ track_ids: [MIRA] })],
    },
    pending_edits: [
      pendingEditView({
        id: "pending-cut",
        track_id: MIRA,
        type: "remove",
        suggested_action: "cut",
      }),
    ],
    comments: [
      sampleComment({ id: "open" }),
      sampleComment({ id: "done", resolved: true }),
    ],
  });
}

const project = editFixtureProject();

const range = (spans: { start: number; end: number }[], tracks: string[]) => {
  const target = makeRangeTarget(project, spans, tracks);
  if (!target) throw new Error("fixture range has no clips");
  return { kind: "range", target } as const;
};

export const EDIT_SELECTIONS = {
  playhead: null,
  liveWords: {
    kind: "transcriptRange",
    trackId: MIRA,
    startWordIndex: 2,
    endWordIndex: 2,
  },
  cutWords: {
    kind: "transcriptRange",
    trackId: MIRA,
    startWordIndex: 0,
    endWordIndex: 1,
  },
  rangeOnAllTracks: range([{ start: 1, end: 2 }], [MIRA, JONAS]),
  rangeOverGap: range([{ start: 4.5, end: 5.5 }], [MIRA]),
  clip: { kind: "clip", id: "a", trackId: MIRA },
  clips: { kind: "clip", id: "a", trackId: MIRA, ids: ["a", "b", "c"] },
  seam: { kind: "applied", id: "edit-1", trackId: MIRA },
  suggestion: { kind: "pending", id: "pending-cut", trackId: MIRA },
  comment: { kind: "comment", id: "open" },
} as const satisfies Record<string, Selection>;

export type BarScene = {
  readonly resolved: ResolvedBar;
  readonly count: number;
  readonly items: BarItem[];
  readonly more: BarItem[];
  readonly primary: BarItem | undefined;
  /** The tracks a Scope chip would show, and whether they are all of them. */
  readonly scope: { readonly tracks: ScopeTrack[]; readonly all: boolean };
};

export const itemsOf = (ids: readonly BarId[]): BarItem[] =>
  ids.map((id) => ({ id }));

const TRACK_COLORS: Record<string, string> = {
  [MIRA]: "var(--color-clip-dialogue-0)",
  [JONAS]: "var(--color-clip-dialogue-1)",
};

export function barScene(
  selection: Selection,
  {
    role = "host",
    clipboardHasAudio = false,
  }: { role?: EditRole; clipboardHasAudio?: boolean } = {},
): BarScene {
  const facts = editFacts(selection, project, { role, clipboardHasAudio });
  const resolved = resolveBar(facts);
  const scoped = project.tracks.filter((track) =>
    facts.span?.trackIds.includes(track.id),
  );
  return {
    resolved,
    count: facts.count,
    items: itemsOf(resolved.bar),
    more: itemsOf(resolved.more),
    primary: resolved.primary ? { id: resolved.primary } : undefined,
    scope: {
      tracks: scoped.map((track) => ({
        id: track.id,
        name: track.label ?? track.id,
        color: TRACK_COLORS[track.id] ?? "var(--color-clip-dialogue-2)",
      })),
      all: scoped.length === project.tracks.length,
    },
  };
}
