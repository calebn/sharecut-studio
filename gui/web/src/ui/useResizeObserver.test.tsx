import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { sourceFiles } from "../test/sourceFiles";
import {
  type ResizeObserverTarget,
  useResizeObserver,
} from "./useResizeObserver";

beforeEach(() => {
  stubResizeObserver();
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
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].targets).toEqual([box]);

    act(() => {
      FakeResizeObserver.all[0].fire();
    });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0][0][0].target).toBe(box);
  });

  it("keeps one observer across re-renders and calls the latest callback", () => {
    const first = vi.fn();
    const { rerender } = render(<Harness onResize={first} />);
    const second = vi.fn();
    rerender(<Harness onResize={second} />);
    expect(FakeResizeObserver.all).toHaveLength(1);

    act(() => {
      FakeResizeObserver.all[0].fire();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps the observer when the same targets only change order", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const onResize = vi.fn();
    const { rerender } = render(<Harness onResize={onResize} extra={[a, b]} />);
    rerender(<Harness onResize={onResize} extra={[b, a]} />);
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].disconnected).toBe(false);
  });

  it("observes several targets (ref, element, getter) with one observer, skipping nulls and duplicates", () => {
    const otherEl = document.createElement("div");
    document.body.appendChild(otherEl);
    const onResize = vi.fn();
    render(
      <Harness onResize={onResize} extra={[otherEl, () => otherEl, null]} />,
    );
    const box = screen.getByTestId("box");
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].targets).toEqual([box, otherEl]);
    document.body.removeChild(otherEl);
  });

  it("disconnects on unmount", () => {
    const onResize = vi.fn();
    const { unmount } = render(<Harness onResize={onResize} />);
    const ro = FakeResizeObserver.all[0];
    unmount();
    expect(ro.disconnected).toBe(true);
  });

  it("re-observes when the target element changes", () => {
    const onResize = vi.fn();
    const { rerender } = render(<Harness onResize={onResize} />);
    const firstBox = screen.getByTestId("box");
    const firstRo = FakeResizeObserver.all[0];

    rerender(<Harness onResize={onResize} swap />);
    const secondBox = screen.getByTestId("box");
    expect(secondBox).not.toBe(firstBox);
    expect(firstRo.disconnected).toBe(true);
    expect(FakeResizeObserver.all).toHaveLength(2);
    expect(FakeResizeObserver.all[1].targets).toEqual([secondBox]);
  });

  it("re-observes when a getter target's element changes between renders", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    let current: Element | null = null;
    const getter = () => current;
    const onResize = vi.fn();
    const { rerender } = render(
      <Harness onResize={onResize} extra={[getter]} />,
    );
    const box = screen.getByTestId("box");
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].targets).toEqual([box]);

    // null -> element: the getter's target appears after the first commit.
    current = a;
    rerender(<Harness onResize={onResize} extra={[getter]} />);
    expect(FakeResizeObserver.all[0].disconnected).toBe(true);
    expect(FakeResizeObserver.all).toHaveLength(2);
    expect(FakeResizeObserver.all[1].targets).toEqual([box, a]);

    // element A -> element B.
    current = b;
    rerender(<Harness onResize={onResize} extra={[getter]} />);
    expect(FakeResizeObserver.all[1].disconnected).toBe(true);
    expect(FakeResizeObserver.all).toHaveLength(3);
    expect(FakeResizeObserver.all[2].targets).toEqual([box, b]);
  });

  it("observes nothing while disabled, then observes when enabled", () => {
    const onResize = vi.fn();
    const { rerender } = render(
      <Harness onResize={onResize} enabled={false} />,
    );
    expect(FakeResizeObserver.all).toHaveLength(0);

    rerender(<Harness onResize={onResize} enabled />);
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].disconnected).toBe(false);

    rerender(<Harness onResize={onResize} enabled={false} />);
    expect(FakeResizeObserver.all[0].disconnected).toBe(true);
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

  it("only test/resizeObserver.ts and test/setup.ts declare a ResizeObserver double", () => {
    const allowed = new Set(["test/resizeObserver.ts", "test/setup.ts"]);
    const localDouble = [
      /\bclass\s+\w*ResizeObserver\w*/,
      /\bResizeObserver\s*=\s*class\b/,
      /["']ResizeObserver["']\s*,\s*class\b/,
    ];
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (allowed.has(rel)) {
        continue;
      }
      if (localDouble.some((re) => re.test(text))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
