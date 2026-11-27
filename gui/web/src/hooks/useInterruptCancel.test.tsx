import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageRotations, resetViewport } from "../test/pageInterrupts";
import {
  listenForDragInterrupt,
  listenForInterrupt,
  listenForRotation,
  useInterruptCancel,
} from "./useInterruptCancel";

function Probe({ cancel, enabled }: { cancel: () => void; enabled?: boolean }) {
  useInterruptCancel(cancel, enabled);
  return null;
}

function setVisibility(state: "hidden" | "visible") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetViewport();
});

describe("useInterruptCancel", () => {
  it("cancels on window blur", () => {
    const cancel = vi.fn();
    render(<Probe cancel={cancel} />);
    fireEvent.blur(window);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels on pagehide", () => {
    const cancel = vi.fn();
    render(<Probe cancel={cancel} />);
    fireEvent(window, new Event("pagehide"));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels when the document becomes hidden, not when it becomes visible", () => {
    const cancel = vi.fn();
    render(<Probe cancel={cancel} />);
    setVisibility("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(cancel).not.toHaveBeenCalled();
    setVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("calls the latest cancel without rebinding", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Probe cancel={first} />);
    view.rerender(<Probe cancel={second} />);
    fireEvent.blur(window);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("listens only while enabled", () => {
    const cancel = vi.fn();
    const view = render(<Probe cancel={cancel} enabled={false} />);
    fireEvent.blur(window);
    expect(cancel).not.toHaveBeenCalled();
    view.rerender(<Probe cancel={cancel} enabled />);
    fireEvent.blur(window);
    expect(cancel).toHaveBeenCalledOnce();
    view.rerender(<Probe cancel={cancel} enabled={false} />);
    fireEvent.blur(window);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("removes its listeners on unmount", () => {
    const cancel = vi.fn();
    const view = render(<Probe cancel={cancel} />);
    view.unmount();
    setVisibility("hidden");
    fireEvent.blur(window);
    fireEvent(window, new Event("pagehide"));
    fireEvent(document, new Event("visibilitychange"));
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("listenForRotation", () => {
  const listen = () => {
    const cancel = vi.fn();
    const stop = new AbortController();
    listenForRotation(cancel, stop.signal);
    return { cancel, stop };
  };

  it("cancels when a resize changes the width", () => {
    const { cancel } = listen();
    pageRotations.widthResize();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel for a resize that leaves the width as it was", () => {
    const { cancel } = listen();
    fireEvent(window, new Event("resize"));
    pageRotations.heightResize();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("measures the width from when it started listening", () => {
    pageRotations.widthResize();
    const { cancel } = listen();
    fireEvent(window, new Event("resize"));
    expect(cancel).not.toHaveBeenCalled();
    pageRotations.widthResize();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels on orientationchange even when the width is unchanged", () => {
    const { cancel } = listen();
    pageRotations.orientationchange();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("removes its listeners when the signal aborts", () => {
    const { cancel, stop } = listen();
    stop.abort();
    pageRotations.orientationchange();
    pageRotations.widthResize();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports both events of one rotation, and a cancel can take that twice", () => {
    const { cancel } = listen();
    pageRotations.widthResize();
    pageRotations.orientationchange();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe("listenForInterrupt", () => {
  it("ignores a rotation", () => {
    const cancel = vi.fn();
    const stop = new AbortController();
    listenForInterrupt(cancel, stop.signal);
    pageRotations.widthResize();
    pageRotations.orientationchange();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.blur(window);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("listenForDragInterrupt", () => {
  const listen = () => {
    const cancel = vi.fn();
    const stop = new AbortController();
    listenForDragInterrupt(cancel, stop.signal);
    return { cancel, stop };
  };

  it("cancels on blur, pagehide, a hidden tab, a width change and orientationchange", () => {
    const { cancel } = listen();
    fireEvent.blur(window);
    fireEvent(window, new Event("pagehide"));
    setVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    pageRotations.widthResize();
    pageRotations.orientationchange();
    expect(cancel).toHaveBeenCalledTimes(5);
  });

  it("does not cancel for a height-only resize", () => {
    const { cancel } = listen();
    pageRotations.heightResize();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("removes every listener when the signal aborts", () => {
    const { cancel, stop } = listen();
    stop.abort();
    setVisibility("hidden");
    fireEvent.blur(window);
    fireEvent(document, new Event("visibilitychange"));
    pageRotations.widthResize();
    pageRotations.orientationchange();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("useInterruptCancel on rotation", () => {
  it("cancels on a width change and on orientationchange, not on a height-only resize", () => {
    const cancel = vi.fn();
    render(<Probe cancel={cancel} />);
    pageRotations.heightResize();
    expect(cancel).not.toHaveBeenCalled();
    pageRotations.widthResize();
    expect(cancel).toHaveBeenCalledOnce();
    pageRotations.orientationchange();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
