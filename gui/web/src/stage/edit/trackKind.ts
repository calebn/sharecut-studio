import type { SystemIconName } from "../../system/icons";

export type TrackRole = "dialogue" | "music" | "sfx" | "intro" | "outro";
export type TrackKind = "voice" | "music" | "other";

const KIND_OF: Readonly<Record<TrackRole, TrackKind>> = {
  dialogue: "voice",
  music: "music",
  intro: "music",
  outro: "music",
  sfx: "other",
};

const ROLE_FOR: Readonly<Record<TrackKind, TrackRole>> = {
  voice: "dialogue",
  music: "music",
  other: "sfx",
};

export const TRACK_KINDS: readonly {
  kind: TrackKind;
  label: string;
  icon: SystemIconName;
}[] = [
  { kind: "voice", label: "Voice", icon: "mic" },
  { kind: "music", label: "Music", icon: "music" },
  { kind: "other", label: "Other", icon: "audio-waveform" },
];

export function kindOf(role: string): TrackKind {
  return KIND_OF[role as TrackRole] ?? "voice";
}

export function roleForKind(role: string, kind: TrackKind): TrackRole | null {
  return kindOf(role) === kind ? null : ROLE_FOR[kind];
}
