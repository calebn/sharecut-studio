import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PageInterrupt, pageInterrupts } from "../test/pageInterrupts";
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
  it("uses the latest callback for a released press without restarting its fallback", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const next = vi.fn();
    const view = render(<Harness onLongPress={first} />);
    const target = view.getByText("target");
    fireEvent.pointerDown(target, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
    });
    vi.advanceTimersByTime(550);
    fireEvent.pointerUp(target, { pointerId: 1 });
    vi.advanceTimersByTime(400);
    view.rerender(<Harness onLongPress={next} />);
    vi.advanceTimersByTime(99);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(next).toHaveBeenCalledExactlyOnceWith(target);
    expect(first).not.toHaveBeenCalled();
    fireEvent.click(target);
    expect(next).toHaveBeenCalledTimes(1);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  describe("page interrupts", () => {
    const interrupts = Object.keys(pageInterrupts) as PageInterrupt[];
    const press = (target: HTMLElement) =>
      fireEvent.pointerDown(target, {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      });
    const setup = () => {
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
      const view = render(<ClickHarness />);
      return { onLongPress, onClick, view, target: view.getByText("target") };
    };
    const expectFreshPress = (
      target: HTMLElement,
      onLongPress: ReturnType<typeof vi.fn>,
      calls: number,
    ) => {
      hold(target);
      fireEvent.click(target);
      expect(onLongPress).toHaveBeenCalledTimes(calls);
    };
    const watchSignals = () => {
      const signals: AbortSignal[] = [];
      for (const host of [window, document]) {
        const add = host.addEventListener.bind(host);
        vi.spyOn(host, "addEventListener").mockImplementation(
          (type: string, listener: unknown, options?: unknown) => {
            const signal = (options as AddEventListenerOptions | undefined)
              ?.signal;
            if (signal && !signals.includes(signal)) signals.push(signal);
            add(
              type,
              listener as EventListener,
              options as AddEventListenerOptions,
            );
          },
        );
      }
      return signals;
    };

    it.each(interrupts)(
      "drops an armed press before it is ready on %s",
      (kind) => {
        const { onLongPress, target } = setup();
        press(target);
        vi.advanceTimersByTime(300);
        pageInterrupts[kind]();
        vi.advanceTimersByTime(300);
        fireEvent.pointerUp(target, { pointerId: 1 });
        vi.runOnlyPendingTimers();
        expect(onLongPress).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(fireEvent.contextMenu(target)).toBe(true);
        expectFreshPress(target, onLongPress, 1);
      },
    );

    it.each(interrupts)("drops a ready press on %s", (kind) => {
      const { onLongPress, target } = setup();
      press(target);
      vi.advanceTimersByTime(600);
      pageInterrupts[kind]();
      expect(fireEvent.contextMenu(target)).toBe(true);
      fireEvent.pointerUp(target, { pointerId: 1 });
      vi.runOnlyPendingTimers();
      expect(onLongPress).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expectFreshPress(target, onLongPress, 1);
    });

    it.each(interrupts)(
      "flushes a released press exactly once on %s",
      (kind) => {
        const { onLongPress, onClick, target } = setup();
        hold(target);
        vi.advanceTimersByTime(100);
        pageInterrupts[kind]();
        expect(onLongPress).toHaveBeenCalledExactlyOnceWith(target);
        expect(vi.getTimerCount()).toBe(0);
        fireEvent.click(target);
        expect(onClick).not.toHaveBeenCalled();
        fireEvent.click(target);
        expect(onClick).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(10_000);
        fireEvent.pointerDown(window, { pointerType: "touch", pointerId: 3 });
        expect(onLongPress).toHaveBeenCalledOnce();
        expectFreshPress(target, onLongPress, 2);
      },
    );

    it("ignores a visible visibilitychange", () => {
      const { onLongPress, target } = setup();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      press(target);
      vi.advanceTimersByTime(600);
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.pointerUp(target, { pointerId: 1 });
      expect(onLongPress).not.toHaveBeenCalled();
      fireEvent(document, new Event("visibilitychange"));
      expect(onLongPress).not.toHaveBeenCalled();
      fireEvent.click(target);
      expect(onLongPress).toHaveBeenCalledOnce();
    });

    it.each([
      ["release", () => fireEvent.pointerUp(window, { pointerId: 1 })],
      ["interrupt", () => pageInterrupts.blur()],
      [
        "movement",
        () =>
          fireEvent.pointerMove(window, {
            pointerId: 1,
            clientX: 40,
            clientY: 10,
          }),
      ],
      [
        "second finger",
        () =>
          fireEvent.pointerDown(window, { pointerType: "touch", pointerId: 2 }),
      ],
      [
        "pointercancel",
        () => fireEvent.pointerCancel(window, { pointerId: 1 }),
      ],
    ])("removes the armed interrupt listeners after %s", (_name, end) => {
      const signals = watchSignals();
      const { target } = setup();
      press(target);
      vi.advanceTimersByTime(600);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
      end();
      expect(signals[0].aborted).toBe(true);
    });

    it.each([
      ["interrupt", () => pageInterrupts.blur()],
      ["fallback timer", () => vi.advanceTimersByTime(500)],
      ["click", (target: HTMLElement) => fireEvent.click(target)],
      [
        "next pointerdown",
        () =>
          fireEvent.pointerDown(window, { pointerType: "touch", pointerId: 2 }),
      ],
    ])("removes the pending interrupt listeners after %s", (_name, end) => {
      const signals = watchSignals();
      const { target } = setup();
      hold(target);
      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      end(target);
      expect(signals[1].aborted).toBe(true);
    });

    it("removes both phases' interrupt listeners on unmount", () => {
      const signals = watchSignals();
      const { view, target } = setup();
      press(target);
      view.unmount();
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
    });

    it("removes the pending interrupt listeners on unmount", () => {
      const signals = watchSignals();
      const { view, onLongPress, target } = setup();
      hold(target);
      view.unmount();
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      vi.runOnlyPendingTimers();
      expect(onLongPress).not.toHaveBeenCalled();
    });
  });
});
