import type { StateCreator } from "zustand";
import type { ProjectView, Selection } from "../types/project";
import {
  chapterSelectionAfter,
  clipClickSelection,
  inspectKeyOf,
  isRangeSelection,
  settleSelection,
  trackClickSelection,
  tracksSelection,
} from "./selection";
import { stageRoleOf } from "./stageRoutes";
import { judgeTranscriptSelection } from "./transcriptSelectionJudge";
import type { DawStore } from "./types";

const localWrites = new WeakMap<() => DawStore, AbortController>();

export function localSelectionWriteSignal(
  getState: () => DawStore,
): AbortSignal {
  let writes = localWrites.get(getState);
  if (!writes) {
    writes = new AbortController();
    localWrites.set(getState, writes);
  }
  return writes.signal;
}

function invalidateLocalSelection(getState: () => DawStore): void {
  const writes = localWrites.get(getState);
  localWrites.delete(getState);
  writes?.abort();
}

type SelectionSlice = Pick<
  DawStore,
  | "selection"
  | "setSelection"
  | "followChapter"
  | "selectClip"
  | "toggleTrackSelected"
  | "selectTracks"
  | "commitRange"
>;

/**
 * The state a new selection implies, shared by local and remote writes. This
 * module is the only one that writes `selection`; every other module spreads
 * this patch (`state/selectionGovernance.test.ts` fails a second writer).
 */
export function selectionPatch(
  current: Selection,
  next: Selection,
  inspectorKey: string | null,
): Pick<DawStore, "selection" | "pendingWireSelection" | "inspectorKey"> &
  Partial<Pick<DawStore, "rangeArmed" | "rangeDraft">> {
  const settled = settleSelection(current, next);
  return {
    selection: settled,
    pendingWireSelection: null,
    inspectorKey: inspectorKeyAfter(settled, inspectorKey),
    ...(isRangeSelection(settled)
      ? { rangeArmed: false, rangeDraft: null }
      : {}),
  };
}

function inspectorKeyAfter(
  selection: Selection,
  inspectorKey: string | null,
): string | null {
  return inspectorKey !== null && inspectorKey === inspectKeyOf(selection)
    ? inspectorKey
    : null;
}

/** The selection patch a project replacement implies for an open chapter, or nothing when it still stands. */
export function chapterFollowPatch(
  state: Pick<DawStore, "selection" | "inspectorKey" | "project">,
  next: DawStore["project"],
): ReturnType<typeof selectionPatch> | Record<string, never> {
  const after = chapterSelectionAfter(
    state.selection,
    state.project?.chapters,
    next?.chapters,
  );
  if (after === undefined) return {};
  const followed =
    after !== null && state.inspectorKey === inspectKeyOf(state.selection)
      ? inspectKeyOf(after)
      : state.inspectorKey;
  return selectionPatch(state.selection, after, followed);
}

/**
 * The project a words selection was last known to name its words in, kept
 * while a replacement arrives without words (the shell now, its words in a
 * later DETAIL merge) or while an own range action holds the follow off.
 */
const namedIn = new WeakMap<object, ProjectView>();

const wordsPending = (project: ProjectView) =>
  project.meta?.hydration?.transcript_words === false;

const sameScript = (a: ProjectView, b: ProjectView) =>
  a.transcript?.utterances === b.transcript?.utterances &&
  a.edit_boundaries === b.edit_boundaries;

/**
 * The selection patch a project replacement implies for a selected run of
 * words, or nothing when it still stands. The store keeps `word_index`
 * numbers, which another session's phrase correction that changes the word count renumbers: the words are followed to
 * their new numbers, or the selection is cleared when they cannot be proven.
 * The guest Review Script looks after itself. While an own range action is in
 * flight, or a replacement has no words yet, the selection is left as it is
 * and judged from the project it was named in at the next replacement that
 * can be judged.
 */
export function transcriptSelectionFollowPatch(
  state: Pick<
    DawStore,
    "selection" | "inspectorKey" | "project" | "guestMode" | "rangeBusy"
  >,
  next: DawStore["project"],
): ReturnType<typeof selectionPatch> | Record<string, never> {
  const sel = state.selection;
  if (sel?.kind !== "transcriptRange" || !next) return {};
  const role = stageRoleOf(state.guestMode);
  if (role !== "host" && role !== "editor") return {};
  const from = namedIn.get(sel) ?? state.project;
  if (!from || sameScript(from, next)) return {};
  if (state.rangeBusy || wordsPending(next)) {
    if (!wordsPending(from)) namedIn.set(sel, from);
    return {};
  }
  const clear = () => selectionPatch(sel, null, state.inspectorKey);
  const judged = judgeTranscriptSelection(from, sel, next);
  if (judged.kind === "wait") {
    namedIn.set(sel, from);
    return {};
  }
  namedIn.delete(sel);
  if (judged.kind === "clear") return clear();
  if (judged.kind === "keep") return {};
  if (
    judged.startWordIndex === sel.startWordIndex &&
    judged.endWordIndex === sel.endWordIndex
  )
    return {};
  return selectionPatch(
    sel,
    {
      ...sel,
      startWordIndex: judged.startWordIndex,
      endWordIndex: judged.endWordIndex,
    },
    state.inspectorKey,
  );
}

/** A new project starts with nothing selected; a wire selection waiting for its target stays. */
export const NO_SELECTION: Pick<DawStore, "selection" | "inspectorKey"> = {
  selection: null,
  inspectorKey: null,
};

/** `next` exactly as given: a click or a set of tracks already worked out the whole selection. */
function exactSelection(
  next: Selection,
  inspectorKey: string | null,
): Pick<DawStore, "selection" | "pendingWireSelection" | "inspectorKey"> {
  return {
    selection: next,
    pendingWireSelection: null,
    inspectorKey: inspectorKeyAfter(next, inspectorKey),
  };
}

export const createSelectionSlice: StateCreator<
  DawStore,
  [],
  [],
  SelectionSlice
> = (set, get) => ({
  selection: null as Selection,
  setSelection: (selection) => {
    invalidateLocalSelection(get);
    set((s) => selectionPatch(s.selection, selection, s.inspectorKey));
  },
  followChapter: (from, to) => {
    const current = get().selection;
    if (
      current?.kind !== "chapter" ||
      current.id !== from.id ||
      current.time !== from.time
    )
      return;
    invalidateLocalSelection(get);
    set((s) =>
      selectionPatch(
        s.selection,
        to,
        s.inspectorKey === inspectKeyOf(from)
          ? inspectKeyOf(to)
          : s.inspectorKey,
      ),
    );
  },
  selectClip: (clipId, trackId, mods) => {
    invalidateLocalSelection(get);
    set((s) =>
      exactSelection(
        clipClickSelection(s.selection, s.project, clipId, trackId, mods),
        s.inspectorKey,
      ),
    );
  },
  toggleTrackSelected: (trackId, additive) => {
    invalidateLocalSelection(get);
    set((s) =>
      exactSelection(
        trackClickSelection(s.selection, trackId, additive),
        s.inspectorKey,
      ),
    );
  },
  commitRange: (target) => {
    invalidateLocalSelection(get);
    set((s) => ({
      ...selectionPatch(s.selection, { kind: "range", target }, s.inspectorKey),
      inspectorKey: "range",
      rangeArmed: false,
      rangeDraft: null,
      agentRangeScope: null,
    }));
  },
  selectTracks: (trackIds) => {
    invalidateLocalSelection(get);
    set((s) => exactSelection(tracksSelection(trackIds), s.inspectorKey));
  },
});
