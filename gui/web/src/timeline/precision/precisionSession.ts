/**
 * One precision drag (#1184), as a state machine:
 *
 *   idle → armed → precision(variant, gain, origin) → committed | cancelled
 *
 * - `arm`: a long-press armed a target that has a time value (a fade, trim,
 *   pending edge or envelope point); `origin` is that value.
 * - `enter`: the variant's surface is up and finger travel maps to time at
 *   `pxPerSec`.
 * - `move`: the finger travelled `dx` px (at gain step `gain`, times
 *   `scale`). The value
 *   lands on whole steps from `origin`. Hard limits always stop it. A soft
 *   boundary holds it until the finger pushes `DRAG_DETENT_PX` past, as an
 *   armed drag's detent does; moving back frees it at once.
 * - `commit` / `cancel`: done, or a second finger rolled it back.
 *
 * The machine is pure: the controller builds the `PrecisionAxis` from the
 * project when the target is armed and turns the states into previews,
 * bumps, saves and rollbacks.
 */
import type { NudgeField } from "../../edit/nudge";
import { nudgeStep } from "../../edit/nudge";
import type { SoftBoundary } from "../../edit/nudgeBoundaries";
import { DRAG_DETENT_PX } from "../../hooks/gestureConstants";
import type { PrecisionStyle } from "./precisionLab";
import {
  frameOf,
  type GainIndex,
  jogGain,
  quantize,
  unitsPerSec,
} from "./precisionMath";

/**
 * How the drag runs: one of the precision styles, or `direct` when Auto
 * judged the target easy to drag (the finger moves it at the timeline's
 * zoom, finer while the finger moves slowly).
 */
export type PrecisionVariant = PrecisionStyle | "direct";

/** The armed target's value against the project it was armed in. */
export interface PrecisionAxis {
  /** Hard limits. */
  clamp: (v: number) => number;
  /** Timeline second of the moving point at `v`; null if it does not move. */
  at: (v: number) => number | null;
  boundaries: readonly SoftBoundary[];
}

export interface PrecisionTarget {
  field: NudgeField;
  /** "Trim end", "Pending start": its name in the readout and announcements. */
  name: string;
}

/** Why the value stopped: a hard limit, or held at a soft boundary. */
export type PrecisionStop =
  | { kind: "limit" }
  | { kind: "boundary"; boundary: SoftBoundary };

interface Held {
  boundary: SoftBoundary;
  /** Finger px pushed past the boundary since it caught. */
  push: number;
  /** The finger's direction (±1) when it caught. */
  dir: 1 | -1;
}

export type PrecisionState =
  | { phase: "idle" }
  | {
      phase: "armed";
      variant: PrecisionVariant;
      target: PrecisionTarget;
      origin: number;
    }
  | {
      phase: "precision";
      variant: PrecisionVariant;
      target: PrecisionTarget;
      origin: number;
      gain: GainIndex;
      /** Finger px per second of the moving point, at gain 1. */
      pxPerSec: number;
      /** The value shown: whole steps from `origin`, inside every limit. */
      value: number;
      /** Where the finger alone would put it, before steps and limits. */
      raw: number;
      held: Held | null;
      /** Set on the move that stopped the value; cleared when it moves on. */
      stop: PrecisionStop | null;
    }
  | {
      phase: "committed";
      variant: PrecisionVariant;
      target: PrecisionTarget;
      origin: number;
      value: number;
    }
  | {
      phase: "cancelled";
      variant: PrecisionVariant;
      target: PrecisionTarget;
      origin: number;
    };

export type PrecisionEvent =
  | {
      type: "arm";
      variant: PrecisionVariant;
      target: PrecisionTarget;
      origin: number;
    }
  | { type: "enter"; pxPerSec: number }
  | {
      type: "move";
      dx: number;
      /** The jog's speed step. */
      gain?: GainIndex;
      /** A factor on this move alone: a direct drag's ballistics. */
      scale?: number;
    }
  | { type: "commit" }
  | { type: "cancel" }
  | { type: "reset" };

export const IDLE: PrecisionState = { phase: "idle" };

type Active = Extract<PrecisionState, { phase: "precision" }>;

function move(s: Active, dx: number, axis: PrecisionAxis, scale = 1): Active {
  const units = unitsPerSec(s.target.field);
  const stepSec = frameOf(s.target.field) / Math.abs(units);
  const k = (units / s.pxPerSec) * jogGain(s.gain, s.pxPerSec, stepSec) * scale;
  if (dx === 0 || k === 0) return s;
  if (s.held) {
    const push = s.held.push + dx * s.held.dir;
    if (push < 0) return { ...s, held: null, raw: s.value, stop: null };
    if (push < DRAG_DETENT_PX) return { ...s, held: { ...s.held, push } };
    // Pushed through: go on from the boundary with what is left over.
    const past = { ...s, held: null, raw: s.value, stop: null };
    return move(past, (push - DRAG_DETENT_PX) * s.held.dir, axis, scale);
  }
  const raw = s.raw + dx * k;
  const want = quantize(raw, s.origin, frameOf(s.target.field));
  if (Math.abs(want - s.value) < 1e-9) return { ...s, raw, stop: null };
  const step = nudgeStep(
    { ...axis, value: s.value, mover: null },
    axis.boundaries,
    s.value,
    want - s.value,
    true,
  );
  if (step.stop?.kind === "boundary") {
    return {
      ...s,
      value: step.value,
      raw: step.value,
      held: { boundary: step.stop.boundary, push: 0, dir: dx > 0 ? 1 : -1 },
      stop: step.stop,
    };
  }
  if (step.stop)
    return { ...s, value: step.value, raw: step.value, stop: step.stop };
  return { ...s, value: step.value, raw, stop: null };
}

/** The next state of a precision drag, against the armed target's `axis`. */
export function precisionReducer(
  state: PrecisionState,
  event: PrecisionEvent,
  axis: PrecisionAxis,
): PrecisionState {
  switch (event.type) {
    case "arm":
      return state.phase === "idle"
        ? {
            phase: "armed",
            variant: event.variant,
            target: event.target,
            origin: event.origin,
          }
        : state;
    case "enter":
      return state.phase === "armed" && event.pxPerSec > 0
        ? {
            ...state,
            phase: "precision",
            gain: 0,
            pxPerSec: event.pxPerSec,
            value: state.origin,
            raw: state.origin,
            held: null,
            stop: null,
          }
        : state;
    case "move": {
      if (state.phase !== "precision") return state;
      const geared =
        event.gain == null ? state : { ...state, gain: event.gain };
      return move(geared, event.dx, axis, event.scale);
    }
    case "commit":
      if (state.phase === "precision") {
        const { variant, target, origin, value } = state;
        return { phase: "committed", variant, target, origin, value };
      }
      if (state.phase === "armed") {
        const { variant, target, origin } = state;
        return { phase: "committed", variant, target, origin, value: origin };
      }
      return state;
    case "cancel":
      if (state.phase === "armed" || state.phase === "precision") {
        const { variant, target, origin } = state;
        return { phase: "cancelled", variant, target, origin };
      }
      return state;
    case "reset":
      return state.phase === "committed" || state.phase === "cancelled"
        ? IDLE
        : state;
  }
}
