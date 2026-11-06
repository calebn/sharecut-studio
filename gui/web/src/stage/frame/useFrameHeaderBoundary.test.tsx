import { act, render, screen } from "@testing-library/react";
import { StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeResizeObserver,
  stubResizeObserver,
} from "../../test/resizeObserver";
import { useFrameHeaderBoundary } from "./useFrameHeaderBoundary";

const PROPERTY = "--frame-header-end";

function rect(top: number, bottom: number, width = 360): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: width,
    width,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Frame({
  shell,
  revision = 0,
}: {
  shell: "phone" | "desktop";
  revision?: number;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  useFrameHeaderBoundary(frameRef, shell);
  return (
    <div ref={frameRef} data-testid="frame" data-revision={revision}>
      <header className="stage-frame-header" data-testid="header" />
    </div>
  );
}

beforeEach(() => {
  stubResizeObserver();
  document.documentElement.style.removeProperty(PROPERTY);
});

afterEach(() => {
  document.documentElement.style.removeProperty(PROPERTY);
  document.documentElement.style.removeProperty("--unrelated-root-value");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useFrameHeaderBoundary", () => {
  it("publishes the rendered header bottom relative to the frame top", () => {
    const view = render(<Frame shell="phone" />);
    const frame = screen.getByTestId("frame");
    const header = screen.getByTestId("header");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(20, 780));
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(rect(28, 179));

    view.rerender(<Frame shell="phone" revision={1} />);

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "159px",
    );
    expect(FakeResizeObserver.all).toHaveLength(1);
    expect(FakeResizeObserver.all[0].targets).toEqual([frame, header]);
  });

  it("remeasures rendered geometry after header or root text size changes", () => {
    const view = render(<Frame shell="phone" />);
    const frame = screen.getByTestId("frame");
    const header = screen.getByTestId("header");
    let frameBox = rect(0, 800);
    let headerBox = rect(0, 44);
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => frameBox);
    vi.spyOn(header, "getBoundingClientRect").mockImplementation(
      () => headerBox,
    );
    view.rerender(<Frame shell="phone" revision={1} />);
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "44px",
    );

    frameBox = rect(0, 800);
    headerBox = rect(0, 185);
    act(() => FakeResizeObserver.of(header).fire(header));

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "185px",
    );
  });

  it("clears the owned boundary on wide-shell transition and unmount", () => {
    const view = render(<Frame shell="phone" />);
    const frame = screen.getByTestId("frame");
    const header = screen.getByTestId("header");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(0, 800));
    vi.spyOn(header, "getBoundingClientRect").mockReturnValue(rect(0, 72));
    view.rerender(<Frame shell="phone" revision={1} />);
    document.documentElement.style.setProperty(
      "--unrelated-root-value",
      "1rem",
    );

    view.rerender(<Frame shell="desktop" revision={2} />);

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--unrelated-root-value"),
    ).toBe("1rem");
    expect(FakeResizeObserver.all[0].disconnected).toBe(true);

    view.rerender(<Frame shell="phone" revision={3} />);
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "72px",
    );
    expect(FakeResizeObserver.all).toHaveLength(2);
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe("");
  });

  it("publishes again after a StrictMode cleanup and remount", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "frame"
          ? rect(0, 800)
          : this.dataset.testid === "header"
            ? rect(0, 64)
            : rect(0, 0);
      },
    );
    const view = render(
      <StrictMode>
        <Frame shell="phone" />
      </StrictMode>,
    );
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "64px",
    );
    view.unmount();
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe("");
    const remounted = render(
      <StrictMode>
        <Frame shell="phone" />
      </StrictMode>,
    );

    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "64px",
    );
    remounted.unmount();
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe("");
  });

  it("removes the boundary when the rendered header has no laid-out box", () => {
    const view = render(<Frame shell="phone" />);
    const frame = screen.getByTestId("frame");
    const header = screen.getByTestId("header");
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(rect(0, 800));
    const headerBox = vi
      .spyOn(header, "getBoundingClientRect")
      .mockReturnValue(rect(0, 64));
    view.rerender(<Frame shell="phone" revision={1} />);
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe(
      "64px",
    );
    headerBox.mockReturnValue(rect(0, 0));
    act(() => FakeResizeObserver.of(header).fire(header));
    expect(document.documentElement.style.getPropertyValue(PROPERTY)).toBe("");
  });
});
