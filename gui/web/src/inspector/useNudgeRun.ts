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
import { documentAuthority } from "../document/authorityState";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
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
  projectEpoch: number;
  seq: number;
  authorityProject: ProjectView | null;
  expectedProject: ProjectView;
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
  /** When the last run ended: the browser's click that follows is swallowed. */
  const endedAt = useRef(Number.NEGATIVE_INFINITY);
  /** A canceled pointer still owns its synthesized release click. */
  const stalePointerClick = useRef(false);

  const discardStale = (r: Run) => {
    const s = useDawStore.getState();
    const sameDocument =
      s.projectPath === r.projectPath &&
      s.projectEpoch === r.projectEpoch &&
      currentDocumentSeq() === r.seq &&
      documentAuthority.project === r.authorityProject;
    if (sameDocument && s.project === r.expectedProject) return false;
    if (r.input === "pointer") stalePointerClick.current = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (run.current === r) run.current = null;
    if (
      sameDocument &&
      r.preview &&
      s.project &&
      s.project.clips === r.preview.clips
    ) {
      s.setProject({ ...s.project, clips: r.origin.clips });
    }
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
        const preview = withNudge(
          r.field.kind === "trim" ? r.origin : store.project,
          r.field,
          next.value,
        );
        r.value = next.value;
        r.moved += 1;
        r.preview = preview;
        r.expectedProject = preview;
        store.setProject(preview);
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
    if (run.current || saving || !s.project) return null;
    setBump(null);
    const r: Run = {
      field,
      delta,
      name,
      input,
      origin: s.project,
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      seq: currentDocumentSeq(),
      authorityProject: documentAuthority.project,
      expectedProject: s.project,
      value: nudgeAxis(s.project, field)?.value ?? Number.NaN,
      moved: 0,
      repeats: 0,
      stopped: false,
      stoppedAt: null,
      preview: null,
      timer: null,
    };
    if (Number.isNaN(r.value)) return null;
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
    if (r.moved === 0) return;
    const revert = () => {
      if (r.preview) {
        revertOptimisticIfUnchanged(r.origin, r.seq, r.projectPath, r.preview);
      }
    };
    if (!save) {
      revert();
      return;
    }
    setSaving(true);
    try {
      if (!(await saveNudge(r.projectPath, r.origin, r.field, r.value))) {
        // The host asked first and changed nothing; its dialog speaks.
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
      setSaving(false);
    }
  };

  // A run still going when the strip unmounts (a new selection) saves.
  const endRef = useRef(end);
  useLayoutEffect(() => {
    endRef.current = end;
  });
  useEffect(() => () => void endRef.current(), []);

  /** Props for one nudge button: `name` is its target's, `delta` its step. */
  const buttonProps = (field: NudgeField, delta: number, name: string) => ({
    "aria-disabled": saving || undefined,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      stalePointerClick.current = false;
      // A touch is captured by the button it pressed: release it, so sliding
      // off the button ends the run.
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
      // Pointer and key presses ran already; a click with neither (assistive
      // technology activating the button) steps once.
      if (run.current || withinGhostClick(endedAt.current)) return;
      event.preventDefault();
      if (begin(field, delta, name, "key")) void end();
    },
  });

  return { buttonProps, saving, bump };
}
