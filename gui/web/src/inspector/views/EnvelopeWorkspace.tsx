import { useRef, useState } from "react";
import { setEnvelope } from "../../api";
import { useMountedRef } from "../../hooks/useMountedRef";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { AutomationPoint } from "../../types/project";
import { errorMessage } from "../../utils/apiError";
import {
  ENVELOPE_POINT_EPSILON,
  envelopeValueAt,
  findVolumeEnvelope,
  replaceEnvelopePoint,
  sameEnvelopePoint,
  sameEnvelopePoints,
  sortedVolumePoints,
} from "../../utils/envelopes";
import {
  type EnvelopeError,
  type EnvelopeForm,
  EnvelopeWorkspaceView,
} from "./EnvelopeWorkspaceView";

type Draft = { form: EnvelopeForm; origin: AutomationPoint[] };

export function EnvelopeWorkspace({
  trackId,
  pointId,
}: {
  trackId: string;
  pointId: string | null;
}) {
  const { project, projectPath, projectEpoch, setSelection } = useDaw(
    (state) => ({
      project: state.project,
      projectPath: state.projectPath,
      projectEpoch: state.projectEpoch,
      setSelection: state.setSelection,
    }),
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<EnvelopeError | null>(null);
  const [collisionId, setCollisionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mounted = useMountedRef();
  const editable = !isShareProjectKey(projectPath);
  const track = project?.tracks.find((item) => item.id === trackId);
  const points = sortedVolumePoints(project?.envelopes, trackId);
  const rawPoints = () =>
    (
      findVolumeEnvelope(useDawStore.getState().project?.envelopes, trackId)
        ?.points ?? []
    ).map((point) => ({ ...point }));
  const targetCurrent = () => {
    const state = useDawStore.getState();
    return (
      mounted.current &&
      state.projectPath === projectPath &&
      state.projectEpoch === projectEpoch &&
      state.project?.tracks.some((item) => item.id === trackId) &&
      (state.selection?.kind === "envelope" ||
        state.selection?.kind === "envelopePoint") &&
      state.selection.trackId === trackId
    );
  };
  const reset = () => {
    setDraft(null);
    setError(null);
    setCollisionId(null);
  };
  const select = (id: string | null) => {
    reset();
    setSelection(
      id
        ? { kind: "envelopePoint", trackId, pointId: id }
        : { kind: "envelope", trackId },
    );
  };
  const start = (kind: "add" | "edit") => {
    if (!editable || lock.current) return;
    const origin = rawPoints();
    const selected = origin.find((point) => point.id === pointId);
    if (kind === "edit" && !selected) return;
    const playheadSec = useDawStore.getState().playheadSec;
    const duration = project?.timeline_duration_sec ?? 0;
    const time =
      kind === "edit"
        ? selected!.time
        : origin.length === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                Number.isFinite(playheadSec) ? playheadSec : 0,
                duration,
              ),
            );
    reset();
    setDraft({
      origin,
      form: {
        kind,
        pointId: kind === "edit" ? selected!.id : crypto.randomUUID(),
        time: String(time),
        ...(kind === "add" && origin.length > 0 && time !== playheadSec
          ? {
              notice: `The playhead is outside this timeline. Suggested time: ${time} seconds. Confirm or enter another time.`,
            }
          : {}),
        level: String(
          kind === "edit" ? selected!.value : envelopeValueAt(origin, time),
        ),
      },
    });
  };
  const commit = async (
    next: AutomationPoint[],
    origin: AutomationPoint[],
    selectedId: string | null,
  ) => {
    if (!editable || lock.current || !targetCurrent()) return;
    if (!sameEnvelopePoints(rawPoints(), origin)) {
      setError({
        target: "form",
        message:
          "This envelope changed since editing started. Reload points before trying again.",
      });
      return;
    }
    if (sameEnvelopePoints(origin, next)) {
      reset();
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await setEnvelope(projectPath, trackId, next, origin);
      if (targetCurrent()) select(selectedId);
    } catch (failure) {
      if (targetCurrent())
        setError({
          target: "form",
          message: errorMessage(failure, "Could not save volume envelope"),
        });
    } finally {
      lock.current = false;
      if (targetCurrent()) setBusy(false);
    }
  };
  const save = () => {
    if (!draft || lock.current) return;
    const { form, origin } = draft;
    const time = Number(form.time);
    const value = Number(form.level);
    setCollisionId(null);
    if (!form.time.trim() || !Number.isFinite(time) || time < 0) {
      setError({
        target: "time",
        message: "Time must be a finite, non-negative number.",
      });
      return;
    }
    if (
      !form.level.trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1.5
    ) {
      setError({
        target: "level",
        message: "Level must be a number from 0 to 1.50.",
      });
      return;
    }
    const oldPoint = origin.find((point) => point.id === form.pointId);
    const collision = origin.find(
      (point) =>
        point.id !== form.pointId &&
        Math.abs(point.time - time) <= ENVELOPE_POINT_EPSILON,
    );
    if (collision && (form.kind === "add" || oldPoint?.time !== time)) {
      setCollisionId(collision.id);
      setError({
        target: "time",
        message:
          "A point already exists at this time. Choose a different time or select that point.",
      });
      return;
    }
    const point = { id: form.pointId, time, value };
    const next =
      oldPoint && sameEnvelopePoint(oldPoint, point)
        ? origin
        : form.kind === "add"
          ? [...origin, point].sort((a, b) => a.time - b.time)
          : replaceEnvelopePoint(origin, point);
    void commit(next, origin, point.id);
  };
  const remove = () => {
    if (lock.current || !pointId) return;
    const origin = (
      findVolumeEnvelope(project?.envelopes, trackId)?.points ?? []
    ).map((point) => ({ ...point }));
    if (!origin.some((point) => point.id === pointId)) return;
    const next = origin.filter((point) => point.id !== pointId);
    void commit(next, origin, next[0]?.id ?? null);
  };
  if (!track) return <aside className="inspector">Track not found</aside>;
  return (
    <EnvelopeWorkspaceView
      trackName={track.label || track.id}
      points={points}
      pointId={pointId}
      editable={editable}
      form={draft?.form ?? null}
      busy={busy}
      error={error}
      collisionId={collisionId}
      onSelect={select}
      onAdd={() => start("add")}
      onEdit={() => start("edit")}
      onChange={(form) => {
        if (draft && !lock.current) setDraft({ ...draft, form });
      }}
      onSave={save}
      onCancel={reset}
      onDelete={remove}
      onReload={reset}
      onDone={() => {
        if (lock.current) return;
        setSelection({ kind: "track", trackId });
        requestAnimationFrame(() => {
          const state = useDawStore.getState();
          if (
            state.projectEpoch === projectEpoch &&
            state.selection?.kind === "track" &&
            state.selection.trackId === trackId
          ) {
            document
              .querySelector<HTMLButtonElement>(
                `[data-envelope-entry="${CSS.escape(trackId)}"]`,
              )
              ?.focus({ preventScroll: true });
          }
        });
      }}
    />
  );
}
