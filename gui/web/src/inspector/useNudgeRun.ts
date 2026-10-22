/**
 * Hold-to-repeat for nudge buttons (#1051 round 4). A press steps once; a
 * finger, pen or mouse held on the button repeats after the long-press hold,
 * faster after a few steps (`nudgeRepeatDelayMs`); a held Enter or Space
 * repeats with the system's own key repeat. Release, cancel, leaving the
 * button or blur end the run.
 *
 * Each step previews in the project (the timeline draws it); the run saves
 * once when it ends, so a held run is one undoable edit. A cancel the timeline
 * router sends because a second finger landed (a pinch never edits) rolls the
 * preview back and saves nothing; a cancel the system sends still ends the
 * run and saves it. Hard limits stop a
 * run. A held step that would reach or cross a soft boundary stops exactly
 * there with a bump cue and a "Stopped at …" announcement; a fresh press
 * goes on past it.
 */
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  endPreview,
  showPreview,
  supersedePreview,
} from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { TRIM_MODE } from "../edit/clipEdgeSave";
import {
  NUDGE_KINDS,
  type NudgeField,
  nudgeAxis,
  nudgeKey,
  nudgeStep,
  previewsAsDraft,
  saveNudge,
  withNudge,
  withNudgeIfUnchanged,
  withNudgeReverted,
} from "../edit/nudge";
import { softBoundaries } from "../edit/nudgeBoundaries";
import {
  nudgeRepeatDelayMs,
  withinGhostClick,
} from "../hooks/gestureConstants";
import { useDawStore } from "../state/dawStore";
import { ownsSavingTrim } from "../state/projectSlice";
import { isReplayed } from "../timeline/hitRouting";
import type { ProjectView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { findVolumeEnvelope, sameEnvelopePoints } from "../utils/envelopes";

/** How long the bump cue shows on the value it stopped. */
const BUMP_MS = 1200;

interface Run {
  field: NudgeField;
  delta: number;
  /** What it is called in announcements: "Trim start", "Envelope point time". */
  name: string;
  input: "pointer" | "key";
  /** The project as saved when the run began; the save is checked against it. */
  origin: ProjectView;
  projectPath: string;
  projectEpoch: number;
  seq: number;
  trimToken: symbol | null;
  value: number;
  /** Steps that moved the value. */
  moved: number;
  /** Auto-repeats fired so far. */
  repeats: number;
  stopped: boolean;
  /** The soft boundary it stopped at, named again when it saves. */
  stoppedAt: string | null;
  preview: ProjectView | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface NudgeBump {
  key: string;
  /** Changes on every bump, so the cue replays. */
  n: number;
}

export function useNudgeRun() {
  const run = useRef<Run | null>(null);
  const showLevels = useDawStore((state) => state.layers.showLevels);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bump, setBump] = useState<NudgeBump | null>(null);
  const bumps = useRef(0);
  const endedAt = useRef(Number.NEGATIVE_INFINITY);
  const stalePointerClick = useRef(false);

  const isEnvelopeNudge = (r: Run) =>
    r.field.kind === "envelope-level" || r.field.kind === "envelope-time";
  const sameOwnedEnvelope = (r: Run) => {
    if (!isEnvelopeNudge(r)) return true;
    const state = useDawStore.getState();
    if (
      !state.project ||
      state.projectPath !== r.projectPath ||
      state.projectEpoch !== r.projectEpoch ||
      currentDocumentSeq() !== r.seq
    )
      return false;
    const expected = r.preview ?? r.origin;
    const currentEnvelope = findVolumeEnvelope(
      state.project.envelopes,
      r.field.trackId,
    );
    const expectedEnvelope = findVolumeEnvelope(
      expected.envelopes,
      r.field.trackId,
    );
    return (
      (currentEnvelope == null) === (expectedEnvelope == null) &&
      (currentEnvelope == null ||
        expectedEnvelope == null ||
        sameEnvelopePoints(currentEnvelope.points, expectedEnvelope.points))
    );
  };
  const abandonRun = (r: Run) => {
    if (previewsAsDraft(r.field)) supersedePreview(nudgeKey(r.field));
    if (r.input === "pointer") stalePointerClick.current = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (run.current === r) run.current = null;
    setRunning(false);
  };

  const discardStale = (r: Run) => {
    const s = useDawStore.getState();
    if (
      !r.trimToken ||
      s.changeHeldTrim({
        kind: "value",
        token: r.trimToken,
        sourceSec: r.value,
      }).kind === "accepted"
    )
      return false;
    if (r.input === "pointer") stalePointerClick.current = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (run.current === r) run.current = null;
    setRunning(false);
    return true;
  };

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(null), BUMP_MS);
    return () => clearTimeout(timer);
  }, [bump]);

  const step = (r: Run, held: boolean) => {
    if (r.field.kind === "trim" && discardStale(r)) return;
    if (!sameOwnedEnvelope(r)) {
      abandonRun(r);
      return;
    }
    const store = useDawStore.getState();
    const axis = nudgeAxis(r.origin, r.field);
    if (!axis || !store.project || r.stopped) return;
    const boundaries = axis.mover
      ? softBoundaries(r.origin, axis.mover, store.playheadSec)
      : [];
    const next = nudgeStep(axis, boundaries, r.value, r.delta, held);
    if (next.value !== r.value) {
      try {
        if (r.trimToken) {
          const result = store.changeHeldTrim({
            kind: "value",
            token: r.trimToken,
            sourceSec: next.value,
          });
          if (result.kind !== "accepted") {
            discardStale(r);
            return;
          }
        } else {
          const basis = store.projectEditBasis();
          if (!basis) return;
          const preview = withNudge(basis, r.field, next.value);
          r.preview = preview;
          if (previewsAsDraft(r.field)) {
            const { field, origin } = r;
            const at = next.value;
            showPreview(
              nudgeKey(field),
              (p) => withNudgeIfUnchanged(p, origin, field, at),
              (p) => withNudge(p, field, at),
            );
          } else {
            store.setProject(preview);
          }
        }
        r.value = next.value;
        r.moved += 1;
      } catch (error) {
        r.stopped = true;
        if (r.timer) clearTimeout(r.timer);
        r.timer = null;
        bumps.current += 1;
        setBump({ key: nudgeKey(r.field), n: bumps.current });
        store.announceStatus(`${r.name} failed: ${errorMessage(error)}`, {
          tone: "error",
        });
        return;
      }
    }
    if (!next.stop) return;
    r.stopped = true;
    if (next.stop.kind === "boundary") r.stoppedAt = next.stop.boundary.label;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    bumps.current += 1;
    setBump({ key: nudgeKey(r.field), n: bumps.current });
    store.announceStatus(
      next.stop.kind === "boundary"
        ? `${r.name} stopped at ${next.stop.boundary.label}`
        : `${r.name} is at its limit`,
      { gesture: true },
    );
  };

  const repeatLater = (r: Run) => {
    r.timer = setTimeout(() => {
      if (run.current !== r) return;
      step(r, true);
      if (run.current !== r) return;
      r.repeats += 1;
      if (!r.stopped) repeatLater(r);
    }, nudgeRepeatDelayMs(r.repeats));
  };

  const begin = (
    field: NudgeField,
    delta: number,
    name: string,
    input: Run["input"],
  ): Run | null => {
    const s = useDawStore.getState();
    if (run.current || saving) return null;
    const envelopeNudge =
      field.kind === "envelope-level" || field.kind === "envelope-time";
    if (envelopeNudge && !s.layers.showLevels) return null;
    const origin = s.projectEditBasis();
    if (!origin) return null;
    const value = nudgeAxis(origin, field)?.value ?? Number.NaN;
    if (Number.isNaN(value)) return null;
    const trimToken = field.kind === "trim" ? Symbol("held trim") : null;
    if (
      trimToken &&
      field.kind === "trim" &&
      s.changeHeldTrim({
        kind: "begin",
        token: trimToken,
        target: {
          trackId: field.trackId,
          clipId: field.clipId,
          edge: field.edge,
          mode: TRIM_MODE,
        },
      }).kind !== "accepted"
    )
      return null;
    setBump(null);
    const r: Run = {
      field,
      delta,
      name,
      input,
      origin,
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      seq: currentDocumentSeq(),
      trimToken,
      value,
      moved: 0,
      repeats: 0,
      stopped: false,
      stoppedAt: null,
      preview: null,
      timer: null,
    };
    run.current = r;
    setRunning(true);
    step(r, false);
    return r;
  };

  const end = async (save = true) => {
    const r = run.current;
    if (!r) return;
    useDawStore.getState().endGestureFeedback();
    if (r.field.kind === "trim" && discardStale(r)) return;
    if (!sameOwnedEnvelope(r)) {
      abandonRun(r);
      endedAt.current = Date.now();
      return;
    }
    run.current = null;
    setRunning(false);
    endedAt.current = Date.now();
    if (r.timer) clearTimeout(r.timer);
    if (r.trimToken) {
      const result = useDawStore.getState().changeHeldTrim({
        kind: "finish",
        token: r.trimToken,
        disposition: save && r.moved > 0 ? "handoff" : "discard",
      });
      if (result.kind !== "handoff") return;
      r.origin = result.origin;
      r.preview = result.preview;
      r.projectPath = result.path;
      r.value = result.value;
    }
    if (r.moved === 0) return;
    const revert = () => {
      if (r.trimToken || !r.preview) return;
      if (previewsAsDraft(r.field)) {
        const key = nudgeKey(r.field);
        const shown = useDawStore.getState().project;
        if (isEnvelopeNudge(r) && !sameOwnedEnvelope(r)) supersedePreview(key);
        else if (
          !isEnvelopeNudge(r) &&
          (!shown || nudgeAxis(shown, r.field)?.value !== r.value)
        )
          endPreview(key);
        else endPreview(key, (p) => withNudgeReverted(p, r.origin, r.field));
        return;
      }
      const state = useDawStore.getState();
      if (
        state.projectPath !== r.projectPath ||
        state.projectEpoch !== r.projectEpoch ||
        currentDocumentSeq() > r.seq ||
        state.project !== r.preview
      )
        return;
      revertOptimisticIfUnchanged(r.origin, r.seq, r.projectPath, r.preview);
    };
    const envelopeNudge = isEnvelopeNudge(r);
    const hiddenEnvelope =
      envelopeNudge && !useDawStore.getState().layers.showLevels;
    if (hiddenEnvelope && r.input === "pointer")
      stalePointerClick.current = true;
    if (!save || hiddenEnvelope) {
      revert();
      return;
    }
    const settle = () => {
      if (r.trimToken)
        useDawStore
          .getState()
          .changeHeldTrim({ kind: "settle", token: r.trimToken });
    };
    const fresh = () =>
      !r.trimToken || ownsSavingTrim(useDawStore.getState(), r.trimToken);
    setSaving(true);
    try {
      const saved = await saveNudge(
        r.projectPath,
        r.origin,
        r.field,
        r.value,
        fresh,
        settle,
      );
      if (!saved) {
        revert();
        return;
      }
      const done = NUDGE_KINDS[r.field.kind].saved;
      useDawStore
        .getState()
        .announceStatus(r.stoppedAt ? `${done} at ${r.stoppedAt}` : done, {
          undo: saved.undo,
        });
    } catch (error) {
      revert();
      useDawStore
        .getState()
        .announceStatus(`${r.name} not saved: ${errorMessage(error)}`, {
          tone: "error",
        });
    } finally {
      settle();
      // A queued save keeps the value shown through its own command draft.
      if (previewsAsDraft(r.field)) endPreview(nudgeKey(r.field));
      setSaving(false);
    }
  };

  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });
  useEffect(() => () => void endRef.current(), []);

  useEffect(() => {
    if (showLevels) return;
    const active = run.current;
    if (
      active &&
      (active.field.kind === "envelope-level" ||
        active.field.kind === "envelope-time")
    ) {
      if (active.input === "pointer") stalePointerClick.current = true;
      void endRef.current(false);
    }
  }, [showLevels]);

  const buttonProps = (field: NudgeField, delta: number, name: string) => ({
    "aria-disabled":
      saving ||
      ((field.kind === "envelope-level" || field.kind === "envelope-time") &&
        !showLevels) ||
      undefined,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      stalePointerClick.current = false;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const r = begin(field, delta, name, "pointer");
      if (r && !r.stopped) repeatLater(r);
    },
    onPointerUp: () => void end(),
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) =>
      void end(!isReplayed(event.nativeEvent)),
    onPointerLeave: () => {
      if (run.current?.input === "pointer") void end();
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const r = run.current;
      if (!event.repeat) {
        if (!r) begin(field, delta, name, "key");
      } else if (r?.input === "key" && nudgeKey(r.field) === nudgeKey(field)) {
        step(r, true);
      }
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") void end();
    },
    onBlur: (_event: FocusEvent<HTMLButtonElement>) => void end(),
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (stalePointerClick.current && event.detail > 0) {
        stalePointerClick.current = false;
        event.preventDefault();
        return;
      }
      if (run.current || withinGhostClick(endedAt.current)) return;
      event.preventDefault();
      if (begin(field, delta, name, "key")) void end();
    },
  });

  return { buttonProps, running, saving, bump };
}
