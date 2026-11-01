import { useCallback, useEffect, useRef, useState } from "react";
import {
  addEnvelopePointAt,
  envelopeSaveInFlight,
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

function refuse(result: { status: string; reason?: string }) {
  if (result.status === "disabled" && result.reason)
    useDawStore.getState().announceStatus(result.reason, { tone: "error" });
}

/**
 * The lane envelope's edits as the leaf's callbacks. A drag moves nothing here
 * (the leaf draws the held point): the last change is kept in a ref and saved
 * once at its end. A nudge is folded into `preview`, which the host draws
 * (the leaf steps each press from the points it is given) and saves once when
 * the key is released. A saved gesture keeps its preview, and the geometry
 * hold, until the save settles and the store's points have followed, so the
 * point never snaps back.
 */
export function useEnvelopeEdits(
  trackId: string,
  /** The points as stored: the preview is dropped when they change after a save. */
  stored: readonly AutomationPoint[],
  readOnly: boolean,
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
    letGo();
    setPreview(null);
  }, [letGo, setPreview]);

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
      saved.current = { stored: storedRef.current, settled: false };
      if (held) release.current = held;
      const result = await setEnvelopePoint(trackId, id, edit);
      if (!alive.current) return;
      refuse(result);
      const pending = saved.current;
      if (result.status !== "ok" || !pending) {
        drop();
        return;
      }
      // The store may already hold the saved point or only get it a moment
      // later: settle now, and drop the preview once the points have changed
      // (the effect above), or after a pause if the save changed nothing.
      pending.settled = true;
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
      if (previewRef.current) return false;
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
      if (envelopeSaveInFlight(trackId) || saved.current?.settled === false)
        return;
      if (saved.current) {
        // A nudge begins on a saved point still waiting for the store: it takes over the preview.
        clearTimeout(idle.current);
        saved.current = null;
      }
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
      if (!p || p.id !== id || saved.current?.settled === false) return;
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
      if (saved.current?.settled === false || envelopeSaveInFlight(trackId)) {
        useDawStore.getState().announceStatus(SAVING, { tone: "error" });
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
      if (dragging.current || previewRef.current) return;
      void addEnvelopePointAt(trackId, time, dbToGain(db)).then(refuse);
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
