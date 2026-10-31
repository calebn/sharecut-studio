import {
  type DragEvent,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  playbackTrackClipped,
  subscribePlaybackClipLatches,
} from "../../audio/playbackClipLatches";
import {
  subscribeTrackLevels,
  trackLevel,
  watchTrackLevel,
} from "../../audio/trackPlayLevels";
import { runPointerCommand } from "../../commands/pointer";
import { presenceAnchor, presenceAnchorProps } from "../../presence/anchors";
import { useDawStore } from "../../state/dawStore";
import { selectedTrackIdsOf } from "../../state/selection";
import { useDaw } from "../../state/useDaw";
import type {
  TrackHeaderForm,
  TrackHeaderProps,
  TrackReorder,
} from "../../system/TrackHeader";
import { laneColorIndex } from "../../timeline/laneColors";
import { useTrackMuteState } from "../../tracks/useTrackMuteState";
import type { TrackView } from "../../types/project";
import { trackFaderDb } from "../../utils/audio";

/** What the column decides for every header, the same for each. */
export type TrackHeaderShared = {
  form: TrackHeaderForm;
  /** The viewer may change the mix: a guest hears it but cannot set a level or a mix mute. */
  mayMix: boolean;
  onDragStart: TrackHeaderProps["onDragStart"];
  onDragEnd: TrackHeaderProps["onDragEnd"];
};

/** What the column knows about this one header. */
export type TrackHeaderOwn = {
  track: TrackView;
  trackIndex: number;
  reorder: TrackReorder | undefined;
  /** The stem is out of date: the ring goes hollow. */
  stale: boolean;
  /** Why it is out of date, or the parts of it that are. */
  status: string | undefined;
};

/** A press on the select button: select the track, and open its details unless it was added to a selection. */
function selectTrack(id: string, additive: boolean): void {
  useDawStore.getState().toggleTrackSelected(id, additive);
  const held = useDawStore.getState();
  if (
    !additive &&
    held.selection?.kind === "track" &&
    held.selection.trackId === id
  ) {
    held.setInspectorOpen(true);
  }
}

const muteTrack = (id: string) =>
  runPointerCommand("track.muteToggle", { trackId: id });

const soloTrack = (id: string) =>
  runPointerCommand("track.soloToggle", { trackId: id });

const setLevel = (id: string, db: number) =>
  runPointerCommand("track.setVolume", { trackId: id, db });

/** Shift with Up or Down on the header: the move commands move the selected track, so select it first. */
function moveTrack(id: string, direction: -1 | 1): void {
  useDawStore.getState().setSelection({ kind: "track", trackId: id });
  runPointerCommand(direction < 0 ? "track.moveUp" : "track.moveDown", {
    trackId: id,
  });
}

/** Where a drag over a header stands: the half of it the pointer is in. */
export function dropEdge(event: DragEvent<HTMLElement>): "before" | "after" {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
}

/**
 * The props of one track header, from the same store fields, selectors and
 * commands the legacy header used: the mute state this listener hears, solo,
 * the saved volume, the live level and the clip light. The callbacks are
 * module functions, so a header redraws only when one of its own values
 * changes, never for a sibling or a playhead frame.
 */
export function useTrackHeaderProps(
  own: TrackHeaderOwn,
  shared: TrackHeaderShared,
): TrackHeaderProps {
  const { track, trackIndex, reorder, stale, status } = own;
  const { form, mayMix, onDragStart, onDragEnd } = shared;
  const id = track.id;
  const label = track.label || id;
  const mute = useTrackMuteState(id, track.muted);
  const { solo, selected, projectEpoch } = useDaw((s) => ({
    solo: Boolean(s.soloTracks[id]),
    selected: selectedTrackIdsOf(s.selection).includes(id),
    projectEpoch: s.projectEpoch,
  }));
  useEffect(() => watchTrackLevel(id), [id]);
  const playing = useSyncExternalStore(
    subscribeTrackLevels,
    () => trackLevel(id),
    () => 0,
  );
  const clipped = useSyncExternalStore(
    subscribePlaybackClipLatches,
    () => playbackTrackClipped(id, projectEpoch),
    () => false,
  );
  const anchorProps = useMemo(
    () => ({
      header: presenceAnchorProps(presenceAnchor("track", id)),
      mute: presenceAnchorProps(presenceAnchor("track", id, "mute")),
      solo: presenceAnchorProps(presenceAnchor("track", id, "solo")),
    }),
    [id],
  );
  return {
    id,
    name: label,
    colorIndex: laneColorIndex(track.role, trackIndex),
    form,
    mute,
    solo,
    level: trackFaderDb(track),
    playing,
    rebuilding: stale,
    clipped,
    status,
    selected,
    reorder,
    anchorProps,
    readOnly: !mayMix,
    onSelect: selectTrack,
    onMute: muteTrack,
    onSolo: soloTrack,
    onLevel: setLevel,
    onMove: moveTrack,
    onDragStart,
    onDragEnd,
  };
}
