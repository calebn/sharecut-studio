import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTwoFingerTap } from "./useTwoFingerTap";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(),
}));

import { execute } from "../commands/execute";

function touchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number }>,
): TouchEvent {
  const event = new Event(type, { bubbles: true }) as TouchEvent;
  Object.defineProperty(event, "touches", {
    value: touches.map((t) => ({
      clientX: t.clientX,
      clientY: t.clientY,
      identifier: 0,
    })),
  });
  return event;
}

describe("useTwoFingerTap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers undo on quick two-finger tap", () => {
    renderHook(() => useTwoFingerTap());

    document.dispatchEvent(
      touchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 120, clientY: 100 },
      ]),
    );
    document.dispatchEvent(touchEvent("touchend", []));

    expect(execute).toHaveBeenCalledWith(
      "history.undo",
      {},
      { skipWhen: true },
    );
  });

  it("ignores single-finger tap", () => {
    renderHook(() => useTwoFingerTap());

    document.dispatchEvent(
      touchEvent("touchstart", [{ clientX: 100, clientY: 100 }]),
    );
    document.dispatchEvent(touchEvent("touchend", []));

    expect(execute).not.toHaveBeenCalled();
  });

  it("ignores two-finger tap with too much movement", () => {
    renderHook(() => useTwoFingerTap());

    document.dispatchEvent(
      touchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 120, clientY: 100 },
      ]),
    );
    // Move far away
    document.dispatchEvent(
      touchEvent("touchmove", [
        { clientX: 200, clientY: 200 },
        { clientX: 220, clientY: 200 },
      ]),
    );
    document.dispatchEvent(touchEvent("touchend", []));

    expect(execute).not.toHaveBeenCalled();
  });
});
