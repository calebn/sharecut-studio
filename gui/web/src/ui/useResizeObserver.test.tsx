import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceFiles } from "../test/sourceFiles";
import {
  type ResizeObserverTarget,
  useResizeObserver,
} from "./useResizeObserver";

/** ResizeObserver stub that records what it watches and fires on demand. */
class RecordingResizeObserver {
  static all: RecordingResizeObserver[] = [];
  targets: Element[] = [];
  disconnected = false;
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    RecordingResizeObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
    this.targets = [];
  }
  fire(target: Element | undefined = this.targets[0]): void {
    this.cb(
      [{ target } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

beforeEach(() => {
  RecordingResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness({
  onResize,
  enabled,
  swap,
  extra,
}: {
  onResize: (entries: readonly ResizeObserverEntry[]) => void;
  enabled?: boolean;
  swap?: boolean;
  extra?: readonly ResizeObserverTarget[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useResizeObserver(extra ? [ref, ...extra] : ref, onResize, enabled);
  return <div key={swap ? "b" : "a"} ref={ref} data-testid="box" />;
}

describe("useResizeObserver", () => {
  it("observes the ref'd element and calls back with the entries", () => {
    const onResize = vi.fn();
    render(<Harness onResize={onResize} />);
    const box = screen.getByTestId("box");
    expect(RecordingResizeObserver.all).toHaveLength(1);
    expect(RecordingResizeObserver.all[0].targets).toEqual([box]);

    act(() => {
      RecordingResizeObserver.all[0].fire();
    });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0][0][0].target).toBe(box);
  });

  it("keeps one observer across re-renders and calls the latest callback", () => {
    const first = vi.fn();
    const { rerender } = render(<Harness onResize={first} />);
    const second = vi.fn();
    rerender(<Harness onResize={second} />);
    expect(RecordingResizeObserver.all).toHaveLength(1);

    act(() => {
      RecordingResizeObserver.all[0].fire();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("observes several targets (ref, element, getter) with one observer, skipping nulls and duplicates", () => {
    const otherEl = document.createElement("div");
    document.body.appendChild(otherEl);
    const onResize = vi.fn();
    render(
      <Harness onResize={onResize} extra={[otherEl, () => otherEl, null]} />,
    );
    const box = screen.getByTestId("box");
    expect(RecordingResizeObserver.all).toHaveLength(1);
    expect(RecordingResizeObserver.all[0].targets).toEqual([box, otherEl]);
    document.body.removeChild(otherEl);
  });

  it("disconnects on unmount", () => {
    const onResize = vi.fn();
    const { unmount } = render(<Harness onResize={onResize} />);
    const ro = RecordingResizeObserver.all[0];
    unmount();
    expect(ro.disconnected).toBe(true);
  });

  it("re-observes when the target element changes", () => {
    const onResize = vi.fn();
    const { rerender } = render(<Harness onResize={onResize} />);
    const firstBox = screen.getByTestId("box");
    const firstRo = RecordingResizeObserver.all[0];

    rerender(<Harness onResize={onResize} swap />);
    const secondBox = screen.getByTestId("box");
    expect(secondBox).not.toBe(firstBox);
    expect(firstRo.disconnected).toBe(true);
    expect(RecordingResizeObserver.all).toHaveLength(2);
    expect(RecordingResizeObserver.all[1].targets).toEqual([secondBox]);
  });

  it("observes nothing while disabled, then observes when enabled", () => {
    const onResize = vi.fn();
    const { rerender } = render(
      <Harness onResize={onResize} enabled={false} />,
    );
    expect(RecordingResizeObserver.all).toHaveLength(0);

    rerender(<Harness onResize={onResize} enabled />);
    expect(RecordingResizeObserver.all).toHaveLength(1);
    expect(RecordingResizeObserver.all[0].disconnected).toBe(false);

    rerender(<Harness onResize={onResize} enabled={false} />);
    expect(RecordingResizeObserver.all[0].disconnected).toBe(true);
  });

  it("is a no-op without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const onResize = vi.fn();
    const { unmount } = render(<Harness onResize={onResize} />);
    expect(() => unmount()).not.toThrow();
  });

  it("only ui/useResizeObserver.ts constructs a ResizeObserver", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (
        rel.includes(".test.") ||
        rel.includes(".stories.") ||
        rel.startsWith("test/")
      ) {
        continue;
      }
      if (rel === "ui/useResizeObserver.ts") {
        continue;
      }
      if (/\bnew ResizeObserver\s*\(/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
