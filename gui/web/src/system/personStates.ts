import type { SystemIconName } from "./icons";

export type PersonTileState =
  | "waiting"
  | "joined"
  | "declined"
  | "lost"
  | "weak"
  | "saving"
  | "saved";

/** Glyph and plain text for each state; the text is always printed. */
export const PERSON_STATES: Record<
  PersonTileState,
  {
    icon: SystemIconName;
    text: string;
    tone: "neutral" | "warning" | "danger" | "success";
  }
> = {
  waiting: { icon: "circle", text: "Waiting", tone: "neutral" },
  joined: { icon: "door-open", text: "Joined", tone: "neutral" },
  declined: { icon: "x", text: "Didn't join", tone: "danger" },
  lost: { icon: "cloud-off", text: "Connection lost", tone: "warning" },
  weak: { icon: "triangle-alert", text: "Weak signal", tone: "warning" },
  saving: { icon: "progress-ring", text: "Saving", tone: "neutral" },
  saved: { icon: "circle-check", text: "Saved", tone: "success" },
};

/** Words on a live-room tile (RoomTile), shared with the vocabulary above. */
export const ROOM_TILE_TEXT = {
  joining: "Joining…",
  lost: "Reconnecting…",
  left: "Left",
  // The spec names the room tile state "Declined"; the flat PersonTile keeps its own wording.
  declined: "Declined",
  weak: PERSON_STATES.weak.text,
  saved: PERSON_STATES.saved.text,
  failed: "Couldn't save",
  invite: "Invite",
} as const;
