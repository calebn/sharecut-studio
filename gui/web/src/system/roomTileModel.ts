import type { PersonData } from "./Person";
import { ROOM_TILE_TEXT } from "./personStates";
import { percentOf } from "./progress";

export type RoomConnection = "good" | "weak" | "lost";
export type RoomSaving = { done: number; total: number } | "saved" | "failed";

type Away = { presence: "joining" | "declined" | "left"; person: PersonData };

export type RoomTileProps =
  | { presence: "placeholder"; onInvite: () => void }
  | Away
  | {
      presence: "live";
      person: PersonData;
      /** 0..1 local meter. Out of range values are clamped. */
      level?: number;
      speaking?: boolean;
      muted?: boolean;
      connection?: RoomConnection;
      /** Listeners show an ear glyph and no level ring. */
      listener?: boolean;
      clipped?: number;
      alert?: boolean;
      /** The self tile adds a meter bar under the name. */
      isMe?: boolean;
      saving?: RoomSaving | null;
    };

export type LiveProps = Extract<RoomTileProps, { presence: "live" }>;

function clamp01(value: number): number {
  return Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value));
}

export function clampLevel(level: number | undefined): number {
  return clamp01(level ?? 0);
}

/** Saved share of the recording, 0..1; an empty total is 0. */
export function savingFraction(done: number, total: number): number {
  return total > 0 ? clamp01(done / total) : 0;
}

/** Whole clips only; anything negative, fractional or not a number is tidied. */
export function clipCount(clipped: number | undefined): number {
  return Number.isFinite(clipped) ? Math.max(0, Math.floor(clipped ?? 0)) : 0;
}

/**
 * What the tile shows, decided once for the picture and the label. The ring
 * rests and nobody reads as speaking when muted or lost (no signal to show),
 * when saving (the take has stopped) and for listeners (they send no level).
 */
export function effectiveLive(props: LiveProps) {
  const lost = props.connection === "lost";
  const resting =
    Boolean(props.muted) ||
    lost ||
    Boolean(props.saving) ||
    Boolean(props.listener);
  return {
    lost,
    level: resting ? 0 : clampLevel(props.level),
    speaking: !resting && Boolean(props.speaking),
  };
}

export function savingPercentText(done: number, total: number): string {
  return `Saving ${percentOf(savingFraction(done, total))}%`;
}

function savingText(saving: RoomSaving): string {
  if (saving === "saved") return ROOM_TILE_TEXT.saved;
  if (saving === "failed") return ROOM_TILE_TEXT.failed;
  return savingPercentText(saving.done, saving.total);
}

/** The one sentence a tile prints, or null when it is simply live or a placeholder. */
export function roomTileStatus(props: RoomTileProps): string | null {
  switch (props.presence) {
    case "placeholder":
      return null;
    case "joining":
      return ROOM_TILE_TEXT.joining;
    case "left":
      return ROOM_TILE_TEXT.left;
    case "declined":
      return ROOM_TILE_TEXT.declined;
    case "live":
      // A failed save is the one thing a lost connection must not hide.
      if (props.saving === "failed") return savingText(props.saving);
      if (props.connection === "lost") return ROOM_TILE_TEXT.lost;
      return props.saving ? savingText(props.saving) : null;
  }
}

/** Every state in words, for assistive tech. Static: it is not a live region. */
export function roomTileLabel(props: RoomTileProps): string {
  if (props.presence === "placeholder") return ROOM_TILE_TEXT.invite;
  const parts: (string | null)[] = [props.person.name];
  if (props.presence !== "live") {
    parts.push(roomTileStatus(props));
    return parts.filter(Boolean).join(", ");
  }
  const { lost, speaking } = effectiveLive(props);
  const clips = clipCount(props.clipped);
  if (lost) parts.push(ROOM_TILE_TEXT.lost);
  if (props.saving) parts.push(savingText(props.saving));
  if (props.listener) parts.push("listening");
  if (props.muted) parts.push("muted");
  if (speaking) parts.push("speaking");
  if (props.connection === "weak") parts.push(ROOM_TILE_TEXT.weak);
  if (clips) parts.push(`${clips} ${clips === 1 ? "clip" : "clips"}`);
  if (props.alert) parts.push("needs attention");
  return parts.join(", ");
}
