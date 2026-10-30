import { mayNudge } from "../../edit/mayNudge";
import { NUDGE_KINDS, type NudgeField, nudgeAxis } from "../../edit/nudge";
import { softBoundaries } from "../../edit/nudgeBoundaries";
import { GHOST_CLICK_MS } from "../../hooks/gestureConstants";
import { useDawStore } from "../../state/dawStore";
import type { ProjectView } from "../../types/project";
import type { HitPoint } from "../hitCandidates";
import { ARMED_ATTR, type PrecisionHandoff } from "../hitRouting";
import { clipEdgeOf, HIT_KINDS, isHitKind } from "../inputContract";
import { vibrate } from "../touchGrammar";
import { lastMode, logDecision } from "./decisionLog";
import {
  decidePrecision,
  fingerWidthPx,
  type PrecisionDecision,
  velocityGain,
} from "./precisionDecision";
import { type PrecisionDriver, precisionDriver } from "./precisionDrivers";
import {
  frameOf,
  type GainIndex,
  jogGainIndex,
  unitsPerSec,
} from "./precisionMath";
import {
  IDLE,
  type PrecisionAxis,
  type PrecisionEvent,
  type PrecisionState,
  type PrecisionStop,
  type PrecisionTarget,
  type PrecisionVariant,
  precisionReducer,
} from "./precisionSession";

export const PRECISION_UI_ATTR = "data-precision-ui";

export interface PrecisionView {
  variant: PrecisionVariant;
  name: string;
  field: NudgeField;
  origin: number;
  value: number;
  gain: GainIndex;
  pxPerSec: number;
  stop: PrecisionStop | null;
  bump: number;
  element: Element;
  finger: HitPoint | null;
  dragging: boolean;
  decision: PrecisionDecision;
}

interface Driving {
  pointerId: number;
  startY: number;
  lastX: number;
  lastAt: number;
  speed: number;
}

interface Session {
  state: PrecisionState;
  axis: PrecisionAxis;
  driver: PrecisionDriver;
  element: Element;
  arming: number | null;
  driving: Driving | null;
  touches: Set<number>;
  moved: boolean;
  bump: number;
  finger: HitPoint | null;
  decision: PrecisionDecision;
  stepPx: number;
  dispose: () => void;
}

let session: Session | null = null;
let view: PrecisionView | null = null;
const listeners = new Set<() => void>();

function publish(next: PrecisionView | null) {
  view = next;
  for (const listener of listeners) listener();
}

export function subscribePrecision(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function precisionView(): PrecisionView | null {
  return view;
}

function render(s: Session) {
  const st = s.state;
  if (st.phase !== "precision") return;
  publish({
    variant: st.variant,
    name: st.target.name,
    field: st.target.field,
    origin: st.origin,
    value: st.value,
    gain: st.gain,
    pxPerSec: st.pxPerSec,
    stop: st.stop,
    bump: s.bump,
    element: s.element,
    finger: s.finger,
    dragging: s.driving != null,
    decision: s.decision,
  });
}

export function precisionTarget(
  project: ProjectView,
  kind: string,
  id: string,
): PrecisionTarget | null {
  if (!isHitKind(kind)) return null;
  const name = HIT_KINDS[kind].label;
  const [nudge] = HIT_KINDS[kind].nudges;
  let field: NudgeField | null = null;
  if (nudge === "fade" || nudge === "trim") {
    const clip = Object.values(project.clips.tracks)
      .flat()
      .find((c) => c.id === id);
    if (clip) {
      field = {
        kind: nudge,
        trackId: clip.track_id,
        clipId: clip.id,
        edge: clipEdgeOf(kind),
      };
    }
  } else if (nudge === "pending") {
    const edit = project.pending_edits.find((e) => e.id === id);
    if (edit) {
      field = {
        kind: "pending",
        trackId: edit.track_id,
        editId: edit.id,
        edge: kind === "pending-start" ? "start" : "end",
      };
    }
  } else if (nudge === "envelope-time") {
    const envelope = project.envelopes.find((e) =>
      e.points.some((p) => p.id === id),
    );
    if (envelope) {
      field = {
        kind: "envelope-time",
        trackId: envelope.track_id,
        pointId: id,
      };
    }
  }
  return field && nudgeAxis(project, field) ? { field, name } : null;
}

const HINTS: Record<PrecisionVariant, string> = {
  direct: "drag sideways to move it, slowly for fine steps, lift to finish",
  jog: "precision, drag in the jog pad, slide up to slow it, Done to finish",
};

function neighbourGapPx(
  element: Element,
  axis: PrecisionAxis,
  value: number,
  pxPerSec: number,
): number | null {
  const box = element.getBoundingClientRect();
  let gap: number | null = null;
  const consider = (d: number) => {
    gap = gap == null ? Math.max(0, d) : Math.min(gap, Math.max(0, d));
  };
  const lane = element.closest("[data-track-id]") ?? element.parentElement;
  for (const other of lane?.querySelectorAll("[data-hit-kind]") ?? []) {
    const kind = other.getAttribute("data-hit-kind");
    if (
      other === element ||
      other.contains(element) ||
      element.contains(other) ||
      !isHitKind(kind) ||
      HIT_KINDS[kind].body
    ) {
      continue;
    }
    const r = other.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    consider(Math.max(r.left - box.right, box.left - r.right));
  }
  const at = axis.at(value);
  if (at != null) {
    for (const b of axis.boundaries) {
      if (Math.abs(b.sec - at) < 1e-6) continue;
      consider(Math.abs(b.sec - at) * pxPerSec - box.width / 2);
    }
  }
  return gap;
}

function dispatch(s: Session, event: PrecisionEvent) {
  const before = s.state;
  s.state = precisionReducer(s.state, event, s.axis);
  const st = s.state;
  if (st.phase !== "precision") return;
  const prev = before.phase === "precision" ? before : null;
  if (st.stop && !prev?.stop) {
    s.bump += 1;
    vibrate();
    useDawStore
      .getState()
      .announceStatus(
        st.stop.kind === "boundary"
          ? `${st.target.name} stopped at ${st.stop.boundary.label}`
          : `${st.target.name} is at its limit`,
        { gesture: true },
      );
  }
  if (!prev || prev.value !== st.value) s.driver.show(st.value);
  render(s);
}

function end(s: Session, event: "commit" | "cancel") {
  if (session !== s) return;
  session = null;
  s.dispose();
  s.state = precisionReducer(s.state, { type: event }, s.axis);
  const st = s.state;
  s.element.removeAttribute(ARMED_ATTR);
  const store = useDawStore.getState();
  store.setTimelineDragging(false);
  store.endGestureFeedback();
  publish(null);
  if (st.phase === "committed" && Math.abs(st.value - st.origin) > 1e-9) {
    void s.driver.commit();
  } else {
    s.driver.cancel();
    if (st.phase === "cancelled") {
      store.announceStatus(`${st.target.name} not changed`);
    }
  }
}

export function commitPrecision(): void {
  if (session) end(session, "commit");
}

export function cancelPrecision(): void {
  if (session) end(session, "cancel");
}

function drive(s: Session, event: PointerEvent, gain?: GainIndex) {
  const d = s.driving;
  if (!d) return;
  const dx = event.clientX - d.lastX;
  const dt = Math.max(1, event.timeStamp - d.lastAt);
  d.speed = 0.5 * (Math.abs(dx) / dt) + 0.5 * d.speed;
  d.lastX = event.clientX;
  d.lastAt = event.timeStamp;
  if (dx !== 0) s.moved = true;
  s.finger = { x: event.clientX, y: event.clientY };
  const st = s.state;
  const scale =
    st.phase === "precision" && st.variant === "direct"
      ? velocityGain(d.speed, s.stepPx)
      : undefined;
  dispatch(s, { type: "move", dx, gain, scale });
}

const startDriving = (event: PointerEvent): Driving => ({
  pointerId: event.pointerId,
  startY: event.clientY,
  lastX: event.clientX,
  lastAt: event.timeStamp,
  speed: 0,
});

function watch(s: Session): () => void {
  const onDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") s.touches.add(event.pointerId);
    if (s.touches.size > 1) {
      end(s, "cancel");
      return;
    }
    const inside =
      event.target instanceof Element &&
      event.target.closest(`[${PRECISION_UI_ATTR}]`);
    if (inside || s.arming != null) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    const swallowClick = (click: Event) => {
      click.stopPropagation();
      click.preventDefault();
    };
    window.addEventListener("click", swallowClick, {
      capture: true,
      once: true,
    });
    setTimeout(
      () => window.removeEventListener("click", swallowClick, true),
      GHOST_CLICK_MS,
    );
    end(s, "commit");
  };
  const onEnd = (event: PointerEvent) => {
    s.touches.delete(event.pointerId);
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onEnd, true);
  window.addEventListener("pointercancel", onEnd, true);
  return () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onEnd, true);
    window.removeEventListener("pointercancel", onEnd, true);
  };
}

function arm(element: Element, down: PointerEvent): boolean {
  const store = useDawStore.getState();
  const project = store.project;
  if (down.pointerType !== "touch" || !project || session) return false;
  if (!element.closest(".stage-frame--phone")) return false;
  const kind = element.getAttribute("data-hit-kind") ?? "";
  const id = element.getAttribute("data-hit-id") ?? "";
  if (
    kind === "pending-start" ||
    kind === "pending-end" ||
    kind === "envelope-point"
  ) {
    return false;
  }
  const target = precisionTarget(project, kind, id);
  if (!target || !mayNudge(store, project, target.field)) return false;
  const nudge = nudgeAxis(project, target.field);
  if (!nudge) return false;
  const axis: PrecisionAxis = {
    clamp: nudge.clamp,
    at: nudge.at,
    boundaries: nudge.mover
      ? softBoundaries(project, nudge.mover, store.playheadSec)
      : [],
  };
  const zoom = store.zoomPxPerSec;
  const stepPx =
    (frameOf(target.field) / Math.abs(unitsPerSec(target.field))) * zoom;
  const key = `${kind}:${id}`;
  const decision = decidePrecision(
    {
      targetPx: element.getBoundingClientRect().width,
      gapPx: neighbourGapPx(element, axis, nudge.value, zoom),
      fingerPx: fingerWidthPx(down.width, down.height),
      stepPx,
    },
    lastMode(key),
  );
  logDecision({ at: Date.now(), target: key, name: target.name, decision });
  if (
    decision.mode === "direct" &&
    isHitKind(kind) &&
    HIT_KINDS[kind].axis === "xy"
  ) {
    return false;
  }
  const variant: PrecisionVariant =
    decision.mode === "precision" ? "jog" : "direct";
  const driver = precisionDriver(kind, id, target.field, target.name);
  if (!driver?.begin()) return false;
  const s: Session = {
    state: IDLE,
    axis,
    driver,
    element,
    arming: down.pointerId,
    driving: startDriving(down),
    touches: new Set(down.pointerType === "touch" ? [down.pointerId] : []),
    moved: false,
    bump: 0,
    finger: { x: down.clientX, y: down.clientY },
    decision,
    stepPx,
    dispose: () => undefined,
  };
  session = s;
  s.dispose = watch(s);
  const { field } = target;
  if (field.kind === "pending") {
    store.setSelection({
      kind: "pending",
      id: field.editId,
      trackId: field.trackId,
    });
  } else if (field.kind === "envelope-time") {
    store.setSelection({
      kind: "envelopePoint",
      trackId: field.trackId,
      pointId: field.pointId,
    });
  }
  element.setAttribute(ARMED_ATTR, "");
  store.setTimelineDragging(true);
  dispatch(s, { type: "arm", variant, target, origin: nudge.value });
  dispatch(s, { type: "enter", pxPerSec: store.zoomPxPerSec });
  store.announceStatus(`${target.name} armed: ${HINTS[variant]}`, {
    gesture: true,
  });
  vibrate();
  return true;
}

export const precisionHandoff: PrecisionHandoff = {
  arm,
  move(event) {
    const s = session;
    if (!s || s.arming !== event.pointerId) return;
    const st = s.state;
    if (st.phase === "precision" && st.variant === "jog") return;
    drive(s, event);
  },
  up(event) {
    const s = session;
    if (!s || s.arming !== event.pointerId) return;
    s.arming = null;
    s.driving = null;
    s.touches.delete(event.pointerId);
    const st = s.state;
    if (st.phase !== "precision") return;
    if (st.variant === "direct") {
      end(s, "commit");
      return;
    }
    render(s);
  },
  cancel() {
    cancelPrecision();
  },
};

export const precisionPad = {
  down(event: PointerEvent, surface: Element) {
    const s = session;
    if (!s || s.driving || s.state.phase !== "precision") return;
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    event.preventDefault();
    s.driving = startDriving(event);
    s.moved = false;
    s.finger = { x: event.clientX, y: event.clientY };
    try {
      surface.setPointerCapture?.(event.pointerId);
    } catch {}
    render(s);
  },
  move(event: PointerEvent) {
    const s = session;
    if (!s || s.driving?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const st = s.state;
    const gain =
      st.phase === "precision" && st.variant === "jog"
        ? jogGainIndex(s.driving.startY - event.clientY)
        : undefined;
    drive(s, event, gain);
  },
  up(event: PointerEvent) {
    const s = session;
    if (!s || s.driving?.pointerId !== event.pointerId) return;
    s.driving = null;
    render(s);
  },
};

export function valueText(field: NudgeField, value: number): string {
  return NUDGE_KINDS[field.kind].format(value);
}
