import { describe, expect, it } from "vitest";
import { COMMANDS } from "./catalog";
import {
  gestureLabel,
  MOBILE_GESTURES,
  referencedGestureCommandIds,
} from "./gestures";

describe("MOBILE_GESTURES", () => {
  it("references only commands from the shared catalog", () => {
    for (const id of referencedGestureCommandIds()) {
      expect(COMMANDS[id], id).toBeDefined();
    }
  });

  it("derives catalog action labels and marks only unimplemented actions planned", () => {
    const undo = MOBILE_GESTURES.find(
      (gesture) => gesture.gesture === "Two-finger tap",
    );
    const longPress = MOBILE_GESTURES.find(
      (gesture) => gesture.gesture === "Long-press",
    );

    expect(undo?.status).toBe("available");
    expect(longPress?.status).toBe("planned");
    expect(undo && gestureLabel(undo)).toBe(COMMANDS["history.undo"].label);
    const pinch = MOBILE_GESTURES.find(
      (gesture) => gesture.gesture === "Pinch",
    );
    expect(pinch && gestureLabel(pinch)).toBe(
      `${COMMANDS["view.zoomIn"].label} / ${COMMANDS["view.zoomOut"].label}`,
    );
  });
});
