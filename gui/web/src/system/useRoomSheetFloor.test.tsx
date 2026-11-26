import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { useRoomSheetFloor } from "./useRoomSheetFloor";

const BOTTOM = "--room-sheet-bottom";
const END = "--room-sheet-end";
const root = document.documentElement;

function rect(left: number, top: number, right: number, bottom: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Room({
  open,
  withDock = true,
  revision = 0,
}: {
  open: boolean;
  withDock?: boolean;
  revision?: number;
}) {
  const roomRef = useRef<HTMLDivElement>(null);
  useRoomSheetFloor(roomRef, open);
  return (
    <div ref={roomRef} data-revision={revision}>
      {withDock ? (
        <div className="sys-room-view-dock" data-testid="dock" />
      ) : null}
    </div>
  );
}

function size(width: number, height: number) {
  vi.spyOn(root, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(root, "clientHeight", "get").mockReturnValue(height);
}

const value = (name: string) => root.style.getPropertyValue(name);

beforeEach(() => {
  stubResizeObserver();
  size(390, 844);
});

afterEach(() => {
  root.style.removeProperty(BOTTOM);
  root.style.removeProperty(END);
  root.removeAttribute("data-room-sheet");
  root.removeAttribute("dir");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useRoomSheetFloor", () => {
  it("insets the slot from the viewport bottom to the dock top and clears the end token", () => {
    root.style.setProperty(END, "99px");
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 740, 390, 844));
    view.rerender(<Room open revision={1} />);
    expect(value(BOTTOM)).toBe("104px");
    expect(value(END)).toBe("");
    expect(root.getAttribute("data-room-sheet")).toBe("bottom");
  });

  it("insets the slot from the end edge to the dock's start in a column, and clears the bottom token", () => {
    size(844, 390);
    root.style.setProperty(BOTTOM, "99px");
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(724, 0, 844, 390));
    view.rerender(<Room open revision={1} />);
    expect(value(END)).toBe("120px");
    expect(value(BOTTOM)).toBe("");
    expect(root.getAttribute("data-room-sheet")).toBe("end");
  });

  it("measures a column from the dock's right edge in right-to-left", () => {
    size(844, 390);
    root.setAttribute("dir", "rtl");
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 0, 120, 390));
    view.rerender(<Room open revision={1} />);
    expect(value(END)).toBe("120px");
  });

  it("never publishes a negative inset", () => {
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 900, 390, 960));
    view.rerender(<Room open revision={1} />);
    expect(value(BOTTOM)).toBe("0px");
  });

  it("measures again on render, on a dock resize, on window and on visualViewport resize", () => {
    const view = render(<Room open={false} />);
    const dock = screen.getByTestId("dock");
    let box = rect(0, 740, 390, 844);
    vi.spyOn(dock, "getBoundingClientRect").mockImplementation(() => box);
    view.rerender(<Room open revision={1} />);
    expect(value(BOTTOM)).toBe("104px");
    expect(FakeResizeObserver.of(dock)).toBeTruthy();

    box = rect(0, 700, 390, 844);
    act(() => FakeResizeObserver.of(dock).fire(dock));
    expect(value(BOTTOM)).toBe("144px");

    box = rect(0, 720, 390, 844);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(value(BOTTOM)).toBe("124px");

    const viewport = new EventTarget();
    vi.stubGlobal("visualViewport", viewport);
    view.rerender(<Room open={false} revision={2} />);
    view.rerender(<Room open revision={3} />);
    box = rect(0, 760, 390, 844);
    act(() => {
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(value(BOTTOM)).toBe("84px");
  });

  it("removes the tokens and the attribute when the sheet closes", () => {
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 740, 390, 844));
    view.rerender(<Room open revision={1} />);
    expect(value(BOTTOM)).toBe("104px");
    view.rerender(<Room open={false} revision={2} />);
    expect(value(BOTTOM)).toBe("");
    expect(root.hasAttribute("data-room-sheet")).toBe(false);
  });

  it("removes them on unmount", () => {
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 740, 390, 844));
    view.rerender(<Room open revision={1} />);
    view.unmount();
    expect(value(BOTTOM)).toBe("");
    expect(root.hasAttribute("data-room-sheet")).toBe(false);
  });

  it("clears when the dock leaves the room", () => {
    const view = render(<Room open={false} />);
    vi.spyOn(
      screen.getByTestId("dock"),
      "getBoundingClientRect",
    ).mockReturnValue(rect(0, 740, 390, 844));
    view.rerender(<Room open revision={1} />);
    view.rerender(<Room open withDock={false} revision={2} />);
    expect(value(BOTTOM)).toBe("");
    expect(root.hasAttribute("data-room-sheet")).toBe(false);
  });

  it("clears when the dock has no laid-out box", () => {
    const view = render(<Room open={false} />);
    const dock = screen.getByTestId("dock");
    const box = vi
      .spyOn(dock, "getBoundingClientRect")
      .mockReturnValue(rect(0, 740, 390, 844));
    view.rerender(<Room open revision={1} />);
    box.mockReturnValue(rect(0, 0, 0, 0));
    act(() => FakeResizeObserver.of(dock).fire(dock));
    expect(value(BOTTOM)).toBe("");
  });

  it("publishes nothing while the sheet is closed", () => {
    render(<Room open={false} />);
    expect(value(BOTTOM)).toBe("");
    expect(root.hasAttribute("data-room-sheet")).toBe(false);
    expect(FakeResizeObserver.all).toHaveLength(0);
  });
});
