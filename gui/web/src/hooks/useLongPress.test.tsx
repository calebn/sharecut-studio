import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "./useLongPress";

function Harness({ onLongPress }: { onLongPress: () => void }) {
  const [visible, setVisible] = useState(true);
  const handlers = useLongPress(onLongPress);
  return visible ? (
    <>
      <button type="button" {...handlers}>
        target
      </button>
      <button type="button" onClick={() => setVisible(false)}>
        unmount
      </button>
    </>
  ) : null;
}

describe("useLongPress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires only for a stationary primary touch", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { getByText } = render(<Harness onLongPress={onLongPress} />);
    const target = getByText("target");
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    vi.advanceTimersByTime(549);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).not.toHaveBeenCalled();
    fireEvent.pointerUp(target, { pointerId: 1 });
    fireEvent.click(target);
    expect(onLongPress).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("uses a fallback when the browser omits click after a held touch", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const target = render(<Harness onLongPress={onLongPress} />).getByText(
      "target",
    );
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
    });
    vi.advanceTimersByTime(550);
    fireEvent.pointerUp(target, { pointerId: 1 });
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "movement",
      (target: HTMLElement) =>
        fireEvent.pointerMove(target, {
          pointerId: 1,
          clientX: 30,
          clientY: 10,
        }),
    ],
    [
      "pointercancel",
      (target: HTMLElement) =>
        fireEvent.pointerCancel(target, { pointerId: 1 }),
    ],
    [
      "secondary touch",
      (target: HTMLElement) =>
        fireEvent.pointerDown(target, {
          pointerType: "touch",
          isPrimary: false,
          pointerId: 2,
        }),
    ],
  ])("cancels on %s", (_name, cancel) => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const target = render(<Harness onLongPress={onLongPress} />).getByText(
      "target",
    );
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    cancel(target);
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores mouse input and unmount clears the timer", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const view = render(<Harness onLongPress={onLongPress} />);
    const target = view.getByText("target");
    fireEvent.pointerDown(target, { pointerType: "mouse", pointerId: 1 });
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
    });
    view.unmount();
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels for a second touch outside the target", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const target = render(<Harness onLongPress={onLongPress} />).getByText(
      "target",
    );
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerDown(window, { pointerType: "touch", pointerId: 2 });
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(target, { pointerId: 1 });
    vi.runOnlyPendingTimers();
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
