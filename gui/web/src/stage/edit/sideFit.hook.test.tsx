import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSideYield } from "./sideFit";

type Observer = { callback: ResizeObserverCallback; targets: Set<Element> };
let observers: Observer[] = [];

class RecordingObserver {
  private readonly record: Observer;
  constructor(callback: ResizeObserverCallback) {
    this.record = { callback, targets: new Set() };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.add(target);
  }
  unobserve(target: Element) {
    this.record.targets.delete(target);
  }
  disconnect() {
    this.record.targets.clear();
    observers = observers.filter((o) => o !== this.record);
  }
}

/** What a browser reports: every observed box that is not the workspace, at its new size. */
function reportOthers(root: Element, widthPx: number) {
  act(() => {
    for (const o of observers) {
      const entries = [...o.targets]
        .filter((el) => el !== root)
        .map((target) => ({
          target,
          contentRect: { width: widthPx },
        }));
      if (entries.length > 0) {
        o.callback(
          entries as unknown as ResizeObserverEntry[],
          {} as ResizeObserver,
        );
      }
    }
  });
}

function reportRoot(root: Element, widthPx: number) {
  act(() => {
    for (const o of observers) {
      if (o.targets.has(root)) {
        o.callback(
          [
            { target: root, contentRect: { width: widthPx } },
          ] as unknown as ResizeObserverEntry[],
          {} as ResizeObserver,
        );
      }
    }
  });
}

function Workspace() {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const yielded = useSideYield(root, true, false);
  return (
    <div
      ref={setRoot}
      data-testid="workspace"
      data-yield={yielded ?? "none"}
      style={
        {
          "--stage-lane-min": "22rem",
          "--header-width": "11.25rem",
          "--stage-script-floor": "12rem",
          "--inspector-width": "17.5rem",
          "--space-3": "0.5rem",
        } as React.CSSProperties
      }
    />
  );
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", RecordingObserver);
  document.documentElement.style.fontSize = "16px";
});

afterEach(() => {
  document.documentElement.style.fontSize = "";
});

describe("useSideYield", () => {
  it("re-measures when the root text size changes and the workspace does not", () => {
    render(<Workspace />);
    const root = screen.getByTestId("workspace");
    // 63.25rem of panes: 1012 px at 16 px text, 1518 px at 24 px.
    reportRoot(root, 1100);
    expect(root).toHaveAttribute("data-yield", "none");

    document.documentElement.style.fontSize = "24px";
    reportOthers(root, 24);
    expect(root).toHaveAttribute("data-yield", "script");

    document.documentElement.style.fontSize = "16px";
    reportOthers(root, 16);
    expect(root).toHaveAttribute("data-yield", "none");
  });

  it("still follows the workspace's own width", () => {
    render(<Workspace />);
    const root = screen.getByTestId("workspace");
    reportRoot(root, 1100);
    expect(root).toHaveAttribute("data-yield", "none");
    reportRoot(root, 900);
    expect(root).toHaveAttribute("data-yield", "script");
  });
});
