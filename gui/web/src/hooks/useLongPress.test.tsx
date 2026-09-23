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

  const hold = (target: HTMLElement) => {
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(target, { pointerId: 1 });
  };

  it("aborts for a second touch whose target stops propagation", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { getByText } = render(
      <>
        <Harness onLongPress={onLongPress} />
        <button type="button" onPointerDown={(e) => e.stopPropagation()}>
          stopper
        </button>
      </>,
    );
    const target = getByText("target");
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerDown(getByText("stopper"), {
      pointerType: "touch",
      isPrimary: false,
      pointerId: 2,
    });
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(target, { pointerId: 1 });
    vi.runOnlyPendingTimers();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("keeps a released press pending through a later pointercancel", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const target = render(<Harness onLongPress={onLongPress} />).getByText(
      "target",
    );
    hold(target);
    fireEvent.pointerCancel(target, { pointerId: 1 });
    fireEvent.click(target);
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("flushes a pending press before another element's pointerdown", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { getByText } = render(
      <>
        <Harness onLongPress={() => order.push("long-press")} />
        <button type="button" onPointerDown={() => order.push("other")}>
          other
        </button>
      </>,
    );
    hold(getByText("target"));
    fireEvent.pointerDown(getByText("other"), { pointerType: "touch" });
    vi.runOnlyPendingTimers();
    expect(order).toEqual(["long-press", "other"]);
  });

  it("swallows a late click that arrives after the fallback fired", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    function ClickHarness() {
      const handlers = useLongPress(onLongPress);
      return (
        <button type="button" {...handlers} onClick={onClick}>
          target
        </button>
      );
    }
    const target = render(<ClickHarness />).getByText("target");
    hold(target);
    vi.advanceTimersByTime(500);
    expect(onLongPress).toHaveBeenCalledOnce();
    fireEvent.click(target);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(target);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("suppresses the native context menu only while a press is armed", () => {
    vi.useFakeTimers();
    const target = render(<Harness onLongPress={vi.fn()} />).getByText(
      "target",
    );
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
    });
    expect(fireEvent.contextMenu(target)).toBe(false);
    fireEvent.pointerCancel(target, { pointerId: 1 });
    expect(fireEvent.contextMenu(target)).toBe(true);
  });
});
