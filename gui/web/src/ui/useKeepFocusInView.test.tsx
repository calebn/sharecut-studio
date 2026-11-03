import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
import { useKeepFocusInView } from "./useKeepFocusInView";

function Pane() {
  const ref = useKeepFocusInView();
  return (
    <div ref={ref} data-testid="host">
      <button type="button" data-testid="control">
        control
      </button>
    </div>
  );
}

type Geometry = { clientHeight: number; scrollHeight: number };

function lay(host: HTMLElement, control: HTMLElement, geometry: Geometry) {
  const state = { scrollTop: 0, ...geometry, controlTop: 0 };
  Object.defineProperty(host, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = Math.max(
        0,
        Math.min(value, state.scrollHeight - state.clientHeight),
      );
    },
  });
  Object.defineProperty(host, "clientHeight", {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(host, "scrollHeight", {
    configurable: true,
    get: () => state.scrollHeight,
  });
  host.getBoundingClientRect = () => new DOMRect(0, 0, 100, state.clientHeight);
  control.getBoundingClientRect = () =>
    new DOMRect(0, state.controlTop - state.scrollTop, 100, 40);
  return state;
}

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(geometry: Geometry, controlTop: number) {
  render(<Pane />);
  const host = screen.getByTestId("host");
  const control = screen.getByTestId("control");
  const state = lay(host, control, geometry);
  state.controlTop = controlTop;
  const scrollIntoView = vi.fn();
  control.scrollIntoView = scrollIntoView;
  return { host, control, state, scrollIntoView };
}

describe("useKeepFocusInView", () => {
  it("keeps its distance from the end when a shrink hides the focused control", () => {
    const { host, control, state, scrollIntoView } = setup(
      { clientHeight: 1500, scrollHeight: 1900 },
      1450,
    );
    act(() => {
      host.scrollTop = 400;
    });
    fireEvent.scroll(host);
    act(() => {
      control.focus();
    });
    state.clientHeight = 700;
    act(() => {
      FakeResizeObserver.of(host).fire(host);
    });
    expect(host.scrollTop).toBe(1200);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the control into view when the end offset still hides it", () => {
    const { host, control, state, scrollIntoView } = setup(
      { clientHeight: 1500, scrollHeight: 1900 },
      1000,
    );
    act(() => {
      host.scrollTop = 400;
    });
    fireEvent.scroll(host);
    act(() => {
      control.focus();
    });
    state.clientHeight = 500;
    act(() => {
      FakeResizeObserver.of(host).fire(host);
    });
    expect(host.scrollTop).toBe(1400);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("leaves a control the reader had already scrolled away from", () => {
    const { host, control, state, scrollIntoView } = setup(
      { clientHeight: 700, scrollHeight: 1900 },
      1450,
    );
    act(() => {
      control.focus();
    });
    state.clientHeight = 600;
    act(() => {
      FakeResizeObserver.of(host).fire(host);
    });
    expect(host.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing while the focus is outside the host", () => {
    const { host, state, scrollIntoView } = setup(
      { clientHeight: 1500, scrollHeight: 1900 },
      1450,
    );
    state.clientHeight = 700;
    act(() => {
      FakeResizeObserver.of(host).fire(host);
    });
    expect(host.scrollTop).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
