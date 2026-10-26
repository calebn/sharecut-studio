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
