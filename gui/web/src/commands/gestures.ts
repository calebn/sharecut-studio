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
    description: "Undo the last action. Optional ShareCut shortcut.",
  },
  {
    gesture: "Long-press",
    label: "Open inspector",
    description: "Open the selection sheet for clips, comments, and tracks.",
  },
  {
    gesture: "Pinch",
    touch: "pinch",
    commandIds: ["view.zoomIn", "view.zoomOut"],
    description: "Pinch in/out on the timeline to zoom.",
  },
  {
    gesture: "Hold a word, then drag",
    touch: "long-press-arm-drag",
    commandIds: ["transcript.extendRange"],
    description:
      "Hold a word in the Script to start a range, then drag over more words. Lift to select them. The range actions also add or drop a word at either end.",
  },
  {
    gesture: "Double-tap word",
    touch: "double-tap",
    commandIds: ["transcript.editWordInline"],
    description:
      "Open Fix text on the word (hosts). A single tap selects the word and moves the playhead to it.",
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
