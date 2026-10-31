import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInterruptCancel } from "./useInterruptCancel";

function Probe({ cancel, enabled }: { cancel: () => void; enabled?: boolean }) {
  useInterruptCancel(cancel, enabled);
  return null;
}

function setVisibility(state: "hidden" | "visible") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

afterEach(() => {
  vi.restoreAllMocks();
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
