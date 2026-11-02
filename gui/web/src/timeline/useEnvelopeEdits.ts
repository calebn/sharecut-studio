import { useCallback, useEffect, useRef, useState } from "react";
import {
  addEnvelopePointAt,
  ENVELOPE_UPDATING,
  envelopeSaveInFlight,
  holdEnvelopeSettling,
  removeEnvelopePoint,
  setEnvelopePoint,
} from "../commands/envelopes";
import { useDawStore } from "../state/dawStore";
import type { EnvelopeChange } from "../system/Envelope";
import { dbToGain, gainToDb } from "../system/envelopeMath";
import type { AutomationPoint } from "../types/project";
import { findVolumeEnvelope } from "../utils/envelopes";
import { editFor, type PointPreview, selectedPointId } from "./envelopePoints";
import { useTimelineGestureHold } from "./timelineMetrics";

/** How long a saved point is held for the store to follow before a save that changed nothing lets go. */
const SETTLE_MS = 1000;
const SAVING = "Wait for the volume envelope to finish saving";

const liveStored = (trackId: string, id: string): AutomationPoint | undefined =>
  findVolumeEnvelope(
    useDawStore.getState().project?.envelopes,
    trackId,
  )?.points.find((p) => p.id === id);

function refuse(
  result: { status: string; reason?: string },
  /** The announcement count before the command ran: a command that already told the refusal is not told again. */
  toldBefore?: number,
) {
  if (result.status !== "disabled" || !result.reason) return;
  const live = useDawStore.getState();
  if (
    toldBefore !== undefined &&
    live.statusAnnouncementSeq !== toldBefore &&
    live.statusAnnouncement.includes(result.reason)
  )
    return;
  live.announceStatus(result.reason, { tone: "error" });
}

/** Tells why a save cannot start: it is running, or the store has yet to follow the last one. */
function wait(trackId: string) {
  useDawStore
    .getState()
    .announceStatus(
      envelopeSaveInFlight(trackId) ? SAVING : ENVELOPE_UPDATING,
      {
        tone: "error",
      },
    );
}

/**
 * The lane envelope's edits as the leaf's callbacks. A drag moves nothing here
 * (the leaf draws the held point): the last change is kept in a ref and saved
 * once at its end. A nudge is folded into `preview`, which the host draws
 * (the leaf steps each press from the points it is given) and saves once when
 * the key is released. A saved gesture keeps its preview until the store's
 * points have followed (or a pause passes if the save changed nothing), so the
 * point never snaps back; the geometry hold is released when the save settles.
 * Until then no drag, nudge or removal starts: each save sends the store's
 * points as its baseline, and a stale baseline is refused as a conflict.
 */
export function useEnvelopeEdits(
  trackId: string,
  /** The points as stored: the preview is dropped when they change after a save. */
  stored: readonly AutomationPoint[],
  readOnly: boolean,
  /** A new project epoch remounts the leaf, so a gesture in progress can never end: drop it. */
  epoch: number,
) {
  const hold = useTimelineGestureHold();
  const [preview, setPreviewState] = useState<PointPreview | null>(null);
  const previewRef = useRef<PointPreview | null>(null);
  const dragging = useRef(false);
  const last = useRef<EnvelopeChange | null>(null);
  const release = useRef<(() => void) | null>(null);
  const saved = useRef<{
    stored: readonly AutomationPoint[];
    settled: boolean;
  } | null>(null);
  const storedRef = useRef(stored);
  const alive = useRef(true);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unsettle = useRef<(() => void) | null>(null);

  const setPreview = useCallback((next: PointPreview | null) => {
    previewRef.current = next;
    setPreviewState(next);
  }, []);
  const letGo = useCallback(() => {
    release.current?.();
    release.current = null;
  }, []);
  const drop = useCallback(() => {
    clearTimeout(idle.current);
    saved.current = null;
    unsettle.current?.();
    unsettle.current = null;
    letGo();
    setPreview(null);
  }, [letGo, setPreview]);
  const epochSeen = useRef(epoch);
  useEffect(() => {
    if (epochSeen.current === epoch) return;
    epochSeen.current = epoch;
    dragging.current = false;
    last.current = null;
    drop();
  }, [epoch, drop]);

  useEffect(() => {
    storedRef.current = stored;
    if (saved.current?.settled && saved.current.stored !== stored) drop();
  }, [stored, drop]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(idle.current);
      saved.current = null;
      previewRef.current = null;
      unsettle.current?.();
      unsettle.current = null;
      release.current?.();
      release.current = null;
    };
  }, []);

  /** Save `edit` while `preview` holds the point where it was put; the hold and preview end once the save settles. */
  const commit = useCallback(
    async (
      id: string,
      edit: { time?: number; value?: number },
      held: (() => void) | null,
    ) => {
      const record = { stored: storedRef.current, settled: false };
      saved.current = record;
      if (held) release.current = held;
      const result = await setEnvelopePoint(trackId, id, edit);
      // A refusal is told even when the lane went away meanwhile (a 409 after an unmount).
      refuse(result);
      if (!alive.current) return;
      // The record of this save: a project switch may have dropped it and a
      // newer gesture started its own, which this response must not settle.
      const pending = record;
      if (saved.current !== pending) return;
      if (result.status !== "ok") {
        drop();
        return;
      }
      // The store may already hold the saved point or only get it a moment
      // later: settle now, and drop the preview once the points have changed
      // (the effect above), or after a pause if the save changed nothing.
      pending.settled = true;
      unsettle.current = holdEnvelopeSettling(trackId);
      letGo();
      if (pending.stored !== storedRef.current) {
        drop();
        return;
      }
      clearTimeout(idle.current);
      idle.current = setTimeout(() => {
        if (saved.current === pending) drop();
      }, SETTLE_MS);
    },
    [trackId, drop, letGo],
  );

  const onSelect = useCallback(
    (id: string) => {
      const live = useDawStore.getState();
      if (selectedPointId(live.selection, trackId) === id) return;
      live.setSelection({ kind: "envelopePoint", trackId, pointId: id });
    },
    [trackId],
  );

  const onDragStart = useCallback(
    (_id: string) => {
      if (readOnly) return false;
      if (envelopeSaveInFlight(trackId)) {
        useDawStore.getState().announceStatus(SAVING, { tone: "error" });
        return false;
      }
      if (previewRef.current || saved.current) return false;
      dragging.current = true;
      last.current = null;
      release.current = hold?.() ?? null;
      return true;
    },
    [readOnly, trackId, hold],
  );

  const onMove = useCallback(
    (id: string, change: EnvelopeChange) => {
      if (dragging.current) {
        last.current = change;
        return;
      }
      // Nothing starts from a saved point until the store holds it: a save
      // sends the store's points as its baseline, and a stale one is a 409.
      if (envelopeSaveInFlight(trackId) || saved.current) return;
      const from =
        previewRef.current?.id === id
          ? previewRef.current
          : startOf(trackId, id);
      if (!from) return;
      setPreview({
        id,
        time: change.timeSeconds ?? from.time,
        db: change.db ?? from.db,
      });
    },
    [trackId, setPreview],
  );

  const onDragEnd = useCallback(
    (id: string, committed: boolean) => {
      dragging.current = false;
      const change = last.current;
      last.current = null;
      const point = liveStored(trackId, id);
      const edit = committed && change && point ? editFor(change, point) : null;
      if (!edit || !point) {
        drop();
        return;
      }
      const from = startOf(trackId, id)!;
      setPreview({
        id,
        time: change!.timeSeconds ?? from.time,
        db: change!.db ?? from.db,
      });
      const held = release.current;
      release.current = null;
      void commit(id, edit, held);
    },
    [trackId, drop, setPreview, commit],
  );

  const onNudgeEnd = useCallback(
    (id: string) => {
      const p = previewRef.current;
      if (!p || p.id !== id || saved.current) return;
      const point = liveStored(trackId, id);
      const edit = point
        ? editFor({ timeSeconds: p.time, db: p.db }, point)
        : null;
      if (!edit) {
        drop();
        return;
      }
      void commit(id, edit, null);
    },
    [trackId, drop, commit],
  );

  const onRemove = useCallback(
    (id: string) => {
      if (saved.current || envelopeSaveInFlight(trackId)) {
        // In flight, the save is running; in the window after it, the store has yet to hold the saved point.
        wait(trackId);
        return;
      }
      void removeEnvelopePoint(trackId, id).then((result) => {
        refuse(result);
        if (result.status === "ok" && previewRef.current?.id === id) drop();
      });
    },
    [trackId, drop],
  );

  const onAdd = useCallback(
    (time: number, db: number) => {
      if (dragging.current) return;
      if (previewRef.current || saved.current) {
        wait(trackId);
        return;
      }
      const toldBefore = useDawStore.getState().statusAnnouncementSeq;
      void addEnvelopePointAt(trackId, time, dbToGain(db)).then((result) =>
        refuse(result, toldBefore),
      );
    },
    [trackId],
  );

  return {
    preview,
    onSelect,
    onDragStart,
    onMove,
    onDragEnd,
    onNudgeEnd,
    onRemove,
    onAdd,
  };
}

function startOf(trackId: string, id: string): PointPreview | null {
  const point = liveStored(trackId, id);
  return point ? { id, time: point.time, db: gainToDb(point.value) } : null;
}
