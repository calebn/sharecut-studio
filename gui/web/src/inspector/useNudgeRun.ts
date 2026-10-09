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
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { TRIM_MODE } from "../edit/clipEdgeSave";
import {
  NUDGE_KINDS,
  type NudgeField,
  nudgeAxis,
  nudgeKey,
  nudgeStep,
  saveNudge,
  withNudge,
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
  const [saving, setSaving] = useState(false);
  const [bump, setBump] = useState<NudgeBump | null>(null);
  const bumps = useRef(0);
  const endedAt = useRef(Number.NEGATIVE_INFINITY);
  const stalePointerClick = useRef(false);

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
    return true;
  };

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(null), BUMP_MS);
    return () => clearTimeout(timer);
  }, [bump]);

  const step = (r: Run, held: boolean) => {
    if (r.field.kind === "trim" && discardStale(r)) return;
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
          store.setProject(preview);
        }
        r.value = next.value;
        r.moved += 1;
      } catch (error) {
        r.stopped = true;
        if (r.timer) clearTimeout(r.timer);
        r.timer = null;
        bumps.current += 1;
        setBump({ key: nudgeKey(r.field), n: bumps.current });
        store.announceStatus(`${r.name} failed: ${errorMessage(error)}`);
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
    step(r, false);
    return r;
  };

  const end = async (save = true) => {
    const r = run.current;
    if (!r) return;
    if (r.field.kind === "trim" && discardStale(r)) return;
    run.current = null;
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
      if (!r.trimToken && r.preview) {
        revertOptimisticIfUnchanged(r.origin, r.seq, r.projectPath, r.preview);
      }
    };
    if (!save) {
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
      const didSave = await saveNudge(
        r.projectPath,
        r.origin,
        r.field,
        r.value,
        fresh,
        settle,
      );
      if (!didSave) {
        revert();
        return;
      }
      const saved = NUDGE_KINDS[r.field.kind].saved;
      useDawStore
        .getState()
        .announceStatus(r.stoppedAt ? `${saved} at ${r.stoppedAt}` : saved);
    } catch (error) {
      revert();
      useDawStore
        .getState()
        .announceStatus(`${r.name} not saved: ${errorMessage(error)}`);
    } finally {
      settle();
      setSaving(false);
    }
  };

  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });
  useEffect(() => () => void endRef.current(), []);

  const buttonProps = (field: NudgeField, delta: number, name: string) => ({
    "aria-disabled": saving || undefined,
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

  return { buttonProps, saving, bump };
}
