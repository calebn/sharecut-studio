import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditingToolRailView } from "./EditingToolRailView";

function props() {
  return {
    bladeAllowed: true,
    mayIngest: true,
    toolMode: "select" as const,
    commentMode: false,
    toolToggle: null,
    history: { canUndo: true, canRedo: false },
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    zoom: { canZoomIn: false, canZoomOut: true },
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onAddTrack: vi.fn(),
    onImport: vi.fn(),
    onCutAtPlayhead: vi.fn(),
  };
}

function peekText() {
  return document.querySelector(".editing-tool-rail-peek")?.textContent ?? "";
}

function longPress(target: Element, pointerType = "touch") {
  fireEvent.pointerDown(target, {
    pointerType,
    isPrimary: true,
    pointerId: 1,
    clientX: 5,
    clientY: 5,
  });
  act(() => {
    vi.advanceTimersByTime(550);
  });
  fireEvent.pointerUp(target, { pointerId: 1 });
  fireEvent.click(target);
  act(() => {
    vi.advanceTimersByTime(0);
  });
}

describe("rail long-press labels", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names an icon-only control without activating it", () => {
    vi.useFakeTimers();
    const p = props();
    render(<EditingToolRailView {...p} />);
    longPress(screen.getByRole("button", { name: "Zoom out" }));
    expect(peekText()).toBe("Zoom out");
    expect(p.onZoomOut).not.toHaveBeenCalled();
  });

  it("adds the reason when the control is unavailable", () => {
    vi.useFakeTimers();
    const p = props();
    render(<EditingToolRailView {...p} />);
    longPress(screen.getByRole("button", { name: "Zoom in" }));
    expect(peekText()).toBe("Zoom in: Fully zoomed in");
    expect(p.onZoomIn).not.toHaveBeenCalled();
  });

  it("stays quiet on a control that already shows its label", () => {
    vi.useFakeTimers();
    const p = props();
    render(<EditingToolRailView {...p} />);
    longPress(screen.getByRole("button", { name: "Import" }));
    expect(peekText()).toBe("");
    expect(p.onImport).toHaveBeenCalledTimes(1);
  });

  it("lets a slow tap on a labelled button activate it", () => {
    vi.useFakeTimers();
    const p = props();
    render(<EditingToolRailView {...p} />);
    longPress(screen.getByRole("button", { name: "Import" }));
    expect(p.onImport).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a button title that only restates its name", () => {
    vi.useFakeTimers();
    const p = props();
    render(
      <EditingToolRailView
        {...p}
        toolToggle={
          <button type="button" aria-label="Select" title="Select (V)">
            <svg aria-hidden="true" />
          </button>
        }
      />,
    );
    longPress(screen.getByRole("button", { name: "Select" }));
    expect(peekText()).toBe("Select");
  });

  it("drops the label when any other press starts", () => {
    vi.useFakeTimers();
    render(<EditingToolRailView {...props()} />);
    longPress(screen.getByRole("button", { name: "Zoom out" }));
    expect(peekText()).toBe("Zoom out");
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(peekText()).toBe("");
  });

  it("fades after a moment and ignores a mouse press", () => {
    vi.useFakeTimers();
    render(<EditingToolRailView {...props()} />);
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    longPress(zoomOut, "mouse");
    expect(peekText()).toBe("");
    longPress(zoomOut);
    expect(peekText()).toBe("Zoom out");
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(peekText()).toBe("");
  });
});
