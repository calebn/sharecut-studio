import type { TouchGestureId } from "../timeline/inputContract";
import { COMMANDS } from "./catalog";

type CatalogGesture = {
  gesture: string;
  /** The manifest's touch column names it so for each command. */
  touch: TouchGestureId;
  commandIds: readonly (keyof typeof COMMANDS)[];
  description: string;
};

type LabelGesture = {
  gesture: string;
  label: string;
  description: string;
};

export type GestureDef = CatalogGesture | LabelGesture;

/**
 * Shipped touch affordances shown in the mobile cheatsheet. Command-backed
 * actions refer to the shared catalog.
 */
export const MOBILE_GESTURES: readonly GestureDef[] = [
  {
    gesture: "Two-finger tap",
    touch: "two-finger-tap",
    commandIds: ["history.undo"],
    description: "Undo the last action. Optional Sharecut shortcut.",
  },
  {
    gesture: "Long-press",
    label: "Open inspector",
    description:
      "Open the selection sheet for clips, comments, and tracks; on a transcript word, open correction (hosts).",
  },
  {
    gesture: "Pinch",
    touch: "pinch",
    commandIds: ["view.zoomIn", "view.zoomOut"],
    description: "Pinch in/out on the timeline to zoom.",
  },
  {
    gesture: "Swipe left on comment",
    touch: "swipe-left",
    commandIds: ["comment.resolve"],
    description:
      "Hosts: swipe left on an open comment in the list to resolve it. Undo appears briefly afterwards.",
  },
  {
    gesture: "Double-tap word",
    touch: "double-tap",
    commandIds: ["transcript.correctIntent"],
    description:
      "Open the word correction sheet (hosts). Tap seeks immediately; closing restores the previous mode.",
  },
];

export function gestureLabel(gesture: GestureDef): string {
  return "commandIds" in gesture
    ? gesture.commandIds.map((id) => COMMANDS[id].label).join(" / ")
    : gesture.label;
}

export function referencedGestureCommandIds(): string[] {
  return MOBILE_GESTURES.flatMap((gesture) =>
    "commandIds" in gesture ? gesture.commandIds : [],
  );
}
