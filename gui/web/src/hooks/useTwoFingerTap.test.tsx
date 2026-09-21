import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { useTwoFingerTap } from "./useTwoFingerTap";

vi.mock("../commands/execute", () => ({ execute: vi.fn() }));

const mockedExecute = vi.mocked(execute);

type TouchPoint = { identifier: number; clientX: number; clientY: number };

function touch(identifier: number, clientX = 0, clientY = 0): TouchPoint {
  return { identifier, clientX, clientY };
}

function dispatchTouch(
  element: HTMLElement,
  type: string,
  touches: TouchPoint[],
  changedTouches: TouchPoint[] = [],
  defaultPrevented = false,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: changedTouches },
  });
  if (defaultPrevented) event.preventDefault();
  element.dispatchEvent(event);
  return event;
}

function Harness({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTwoFingerTap(ref, { enabled });
  return <div ref={ref} data-testid="tap-target" />;
}

function twoFingerTap(target: HTMLElement) {
  const first = touch(1, 10, 10);
  const second = touch(2, 50, 10);
  dispatchTouch(target, "touchstart", [first]);
  dispatchTouch(target, "touchstart", [first, second], [second]);
  dispatchTouch(target, "touchend", [second], [first]);
  return dispatchTouch(target, "touchend", [], [second]);
}

describe("useTwoFingerTap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    mockedExecute.mockReset();
    mockedExecute.mockResolvedValue({ status: "ok" });
    useDawStore.getState().announceStatus("");
  });

  afterEach(() => vi.useRealTimers());

  it("recognizes a sequential two-finger tap and prevents its final touchend", async () => {
    const { getByTestId } = render(<Harness />);
    const finalEnd = twoFingerTap(getByTestId("tap-target"));

    await act(async () => {});
    expect(mockedExecute).toHaveBeenCalledWith("history.undo");
    expect(finalEnd.defaultPrevented).toBe(true);
  });

  it("preserves the first contact origin and enforces the second-finger delay", async () => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("tap-target");
    const first = touch(1, 10, 10);
    dispatchTouch(target, "touchstart", [first]);
    vi.advanceTimersByTime(151);
    dispatchTouch(target, "touchstart", [first, touch(2, 50, 10)]);
    dispatchTouch(target, "touchend", []);

    dispatchTouch(target, "touchstart", [first]);
    dispatchTouch(target, "touchstart", [touch(1, 40, 10), touch(2, 50, 10)]);
    dispatchTouch(target, "touchend", []);
    await act(async () => {});
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["finger movement", [touch(1, 40, 10), touch(2, 50, 10)]],
    ["symmetric pinch", [touch(1, 18, 10), touch(2, 42, 10)]],
    ["rotation", [touch(1, 13, 0), touch(2, 47, 20)]],
  ])("cancels on %s", async (_name, movedTouches) => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("tap-target");
    const first = touch(1, 10, 10);
    const second = touch(2, 50, 10);
    dispatchTouch(target, "touchstart", [first, second]);
    dispatchTouch(target, "touchmove", movedTouches);
    dispatchTouch(target, "touchend", [], movedTouches);

    await act(async () => {});
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it("checks pinch geometry again when movement is coalesced into touchend", async () => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("tap-target");
    dispatchTouch(target, "touchstart", [touch(1, 10, 10), touch(2, 50, 10)]);
    dispatchTouch(target, "touchend", [], [touch(1, 18, 10), touch(2, 42, 10)]);

    await act(async () => {});
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it("cancels default-prevented moves, invalid contacts, timeouts, and cancellations", async () => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("tap-target");
    const first = touch(1, 10, 10);
    const second = touch(2, 50, 10);
    dispatchTouch(target, "touchstart", [first, second]);
    dispatchTouch(target, "touchmove", [first, second], [], true);
    dispatchTouch(target, "touchend", []);

    dispatchTouch(target, "touchstart", [first, second]);
    dispatchTouch(target, "touchstart", [first, second, touch(3, 90, 10)]);
    dispatchTouch(target, "touchend", []);

    dispatchTouch(target, "touchstart", [first, touch(1, 50, 10)]);
    dispatchTouch(target, "touchend", []);

    dispatchTouch(target, "touchstart", [first, second]);
    vi.advanceTimersByTime(301);
    dispatchTouch(target, "touchend", []);

    dispatchTouch(target, "touchstart", [first, second]);
    dispatchTouch(target, "touchcancel", []);

    twoFingerTap(target);
    await act(async () => {});
    expect(mockedExecute).toHaveBeenCalledTimes(1);
  });

  it("does not run while disabled and reports command result failures", async () => {
    const { getByTestId, rerender } = render(<Harness enabled={false} />);
    twoFingerTap(getByTestId("tap-target"));
    await act(async () => {});
    expect(mockedExecute).not.toHaveBeenCalled();

    mockedExecute.mockResolvedValueOnce({
      status: "disabled",
      reason: "No project",
    });
    rerender(<Harness />);
    twoFingerTap(getByTestId("tap-target"));
    await act(async () => {});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undo failed: No project",
    );

    mockedExecute.mockRejectedValueOnce(new Error("network"));
    twoFingerTap(getByTestId("tap-target"));
    await act(async () => {});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undo failed: network",
    );
  });

  it("recovers after a single touch, timeout, or cancellation reaches zero contacts", async () => {
    const { getByTestId } = render(<Harness />);
    const target = getByTestId("tap-target");
    const first = touch(1, 10, 10);
    const second = touch(2, 50, 10);

    dispatchTouch(target, "touchstart", [first]);
    dispatchTouch(target, "touchend", [], [first]);
    twoFingerTap(target);

    dispatchTouch(target, "touchstart", [first, second]);
    vi.advanceTimersByTime(301);
    dispatchTouch(target, "touchend", [], [first, second]);
    twoFingerTap(target);

    dispatchTouch(target, "touchstart", [first, second]);
    dispatchTouch(target, "touchcancel", []);
    twoFingerTap(target);

    await act(async () => {});
    expect(mockedExecute).toHaveBeenCalledTimes(3);
  });

  it("removes gesture listeners and its timeout on unmount", async () => {
    const { getByTestId, unmount } = render(<Harness />);
    const target = getByTestId("tap-target");
    dispatchTouch(target, "touchstart", [touch(1, 10, 10)]);
    unmount();
    vi.advanceTimersByTime(301);
    twoFingerTap(target);

    await act(async () => {});
    expect(mockedExecute).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });
});
