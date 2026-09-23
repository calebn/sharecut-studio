import { COMMANDS } from "./catalog";

type CatalogGesture = {
  gesture: string;
  commandIds: readonly (keyof typeof COMMANDS)[];
  description: string;
};

type TouchGesture = {
  gesture: string;
  label: string;
  description: string;
};

export type GestureDef = CatalogGesture | TouchGesture;

/**
 * Shipped touch affordances shown in the mobile cheatsheet. Command-backed
 * actions refer to the shared catalog.
 */
export const MOBILE_GESTURES: readonly GestureDef[] = [
  {
    gesture: "Two-finger tap",
    commandIds: ["history.undo"],
    description: "Undo the last action. iOS system convention.",
  },
  {
    gesture: "Long-press",
    label: "Open inspector",
    description:
      "Open the selection sheet for clips, comments, and tracks; on a transcript word, open correction (hosts).",
  },
  {
    gesture: "Pinch",
    commandIds: ["view.zoomIn", "view.zoomOut"],
    description: "Pinch in/out on the timeline to zoom.",
  },
  {
    gesture: "Swipe left on comment",
    label: "Resolve",
    description:
      "Hosts: swipe left on an open comment in the list to resolve it.",
  },
  {
    gesture: "Double-tap word",
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
