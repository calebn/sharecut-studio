import type { ClipRow, JoinMode } from "../types/project";

export type EditType = "cut" | "fade" | "crossfade" | "mute" | "split";

export type EditMarkerKind =
  | "join-cut"
  | "join-fade"
  | "join-crossfade"
  | "pending-remove"
  | "pending-mute"
  | "pending-split"
  | "applied-seam"
  | "applied-edge"
  | "applied-mute";

export type JoinMarkerKind = Extract<EditMarkerKind, `join-${string}`>;
type PendingMarkerKind = Extract<EditMarkerKind, `pending-${string}`>;
type AppliedMarkerKind = Extract<EditMarkerKind, `applied-${string}`>;

interface EditMarkerSpec {
  type: EditType;
  label: string;
  longLabel?: string;
}

export const EDIT_MARKERS = {
  "join-cut": { type: "cut", label: "Cut", longLabel: "Cut (no fade)" },
  "join-fade": {
    type: "fade",
    label: "Fade",
    longLabel: "Fade at join (dip)",
  },
  "join-crossfade": {
    type: "crossfade",
    label: "Crossfade",
    longLabel: "Crossfade (overlap both clips)",
  },
  "pending-remove": { type: "cut", label: "Cut" },
  "pending-mute": { type: "mute", label: "Mute" },
  "pending-split": { type: "split", label: "Split" },
  "applied-seam": { type: "cut", label: "Cut" },
  "applied-edge": { type: "split", label: "Edge" },
  "applied-mute": { type: "mute", label: "Mute" },
} as const satisfies Record<EditMarkerKind, EditMarkerSpec>;

export const EDIT_GLYPH_PATH: Record<JoinMode, string> = {
  cut: "M6 1V11",
  fade: "M1 2L6 10L11 2",
  crossfade: "M1 1L11 11M11 1L1 11",
};

export const JOIN_KINDS: readonly JoinMarkerKind[] = [
  "join-cut",
  "join-fade",
  "join-crossfade",
];

export const JOIN_MODE_OPTIONS: readonly {
  value: JoinMode;
  label: string;
  short: string;
}[] = JOIN_KINDS.map((kind) => ({
  value: EDIT_MARKERS[kind].type,
  label: EDIT_MARKERS[kind].longLabel,
  short: EDIT_MARKERS[kind].label,
}));

export function markerLabel(kind: EditMarkerKind): string {
  return EDIT_MARKERS[kind].label;
}

export function markerVariant(kind: EditMarkerKind): string {
  return kind.slice(kind.indexOf("-") + 1);
}

/** A join's on-timeline text: its type, then its length when it has one ("Crossfade 120 ms", "Fade 80 ms", "Cut"). */
export function joinMarkLabel(kind: JoinMarkerKind, lengthMs: number): string {
  const label = markerLabel(kind);
  return kind === "join-cut" || !(lengthMs > 0)
    ? label
    : `${label} ${Math.round(lengthMs)} ms`;
}

export function markerType(kind: EditMarkerKind): EditType {
  return EDIT_MARKERS[kind].type;
}

export function joinKind(right: Pick<ClipRow, "join_in_mode">): JoinMarkerKind {
  if (right.join_in_mode === "cut") {
    return "join-cut";
  }
  return right.join_in_mode === "crossfade" ? "join-crossfade" : "join-fade";
}

export function joinModeOf(right: Pick<ClipRow, "join_in_mode">): JoinMode {
  return EDIT_MARKERS[joinKind(right)].type;
}

const PENDING_KIND_OF_TYPE: Record<string, PendingMarkerKind> = {
  remove: "pending-remove",
  mute: "pending-mute",
  split: "pending-split",
};

export function knownPendingKind(type: string): PendingMarkerKind | null {
  return Object.hasOwn(PENDING_KIND_OF_TYPE, type)
    ? PENDING_KIND_OF_TYPE[type]
    : null;
}

export function pendingKind(type: string): PendingMarkerKind {
  return knownPendingKind(type) ?? "pending-remove";
}

export function appliedKind(tick: {
  kind: "seam" | "edge";
  mute: boolean;
}): AppliedMarkerKind {
  if (tick.mute) {
    return "applied-mute";
  }
  return tick.kind === "seam" ? "applied-seam" : "applied-edge";
}
