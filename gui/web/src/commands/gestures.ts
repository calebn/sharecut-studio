import { COMMANDS } from "./catalog";

export type GestureStatus = "available" | "planned";

type CatalogGesture = {
  gesture: string;
  commandIds: readonly (keyof typeof COMMANDS)[];
  description: string;
  status: GestureStatus;
};

type ProposedGesture = {
  gesture: string;
  proposal: string;
  description: string;
  status: "planned";
};

export type GestureDef = CatalogGesture | ProposedGesture;

/**
 * Touch affordances shown in the mobile cheatsheet. Executable actions refer
 * to the shared command catalog; proposals stay explicit until implemented.
 */
export const MOBILE_GESTURES: readonly GestureDef[] = [
  {
    gesture: "Two-finger tap",
    commandIds: ["history.undo"],
    description: "Undo the last action. iOS system convention.",
    status: "planned",
  },
  {
    gesture: "Long-press",
    proposal: "Context actions",
    description:
      "Open the selection sheet for clips, words, comments, and tracks.",
    status: "planned",
  },
  {
    gesture: "Pinch",
    commandIds: ["view.zoomIn", "view.zoomOut"],
    description: "Pinch in/out on the timeline to zoom.",
    status: "available",
  },
  {
    gesture: "Swipe left on comment",
    proposal: "Resolve comment",
    description: "Quick-resolve a comment from the list.",
    status: "planned",
  },
  {
    gesture: "Double-tap word",
    proposal: "Correct word",
    description: "Open the word correction sheet.",
    status: "planned",
  },
];

export function gestureLabel(gesture: GestureDef): string {
  return "commandIds" in gesture
    ? gesture.commandIds.map((id) => COMMANDS[id].label).join(" / ")
    : gesture.proposal;
}

export function referencedGestureCommandIds(): string[] {
  return MOBILE_GESTURES.flatMap((gesture) =>
    "commandIds" in gesture ? gesture.commandIds : [],
  );
}
