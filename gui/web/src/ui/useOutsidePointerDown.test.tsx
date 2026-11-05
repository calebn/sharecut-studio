import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

function Harness({
  onOutside,
  enabled = true,
  capture = false,
}: {
  onOutside: () => void;
  enabled?: boolean;
  capture?: boolean;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  useOutsidePointerDown({
    nodes: [panel, trigger],
    onOutside,
    enabled,
    capture,
  });
  return (
    <div>
      <button ref={setTrigger} type="button">
        Trigger
      </button>
      <div ref={setPanel} data-testid="panel">
        <span>Inside</span>
      </div>
      <p>Outside</p>
    </div>
  );
}

describe("useOutsidePointerDown", () => {
  it("reads a foreign anchor's live target without requiring a rerender", () => {
    const onOutside = vi.fn();
    const first = document.createElement("button");
    const second = document.createElement("button");
    const anchor = createRef<HTMLButtonElement>();
    anchor.current = first;
    document.body.append(first, second);
    function LiveAnchor({ target }: { target: RefObject<HTMLElement | null> }) {
      useOutsidePointerDown({ liveRefs: [target], onOutside });
      return null;
    }
    const { unmount } = render(<LiveAnchor target={anchor} />);
    try {
      fireEvent.pointerDown(first);
      anchor.current = second;
      fireEvent.pointerDown(second);
      expect(onOutside).not.toHaveBeenCalled();
      fireEvent.pointerDown(first);
      expect(onOutside).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      first.remove();
      second.remove();
    }
  });

  it("fires for a pointerdown outside every ref, not inside one", () => {
    const onOutside = vi.fn();
    render(<Harness onOutside={onOutside} />);
    fireEvent.pointerDown(screen.getByText("Inside"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Trigger" }));
    expect(onOutside).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    const onOutside = vi.fn();
    render(<Harness onOutside={onOutside} enabled={false} />);
    fireEvent.pointerDown(document.body);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", () => {
    const onOutside = vi.fn();
    const { unmount } = render(<Harness onOutside={onOutside} />);
    unmount();
    fireEvent.pointerDown(document.body);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it("calls the latest callback", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onOutside={first} />);
    rerender(<Harness onOutside={second} />);
    fireEvent.pointerDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "registers and removes the matching capture listener (%s)",
    (capture) => {
      const onOutside = vi.fn();
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const { unmount } = render(
        <Harness onOutside={onOutside} capture={capture} />,
      );
      const registration = add.mock.calls.find(
        ([type]) => type === "pointerdown",
      );
      expect(registration?.[2]).toEqual({ capture });
      unmount();
      const cleanup = remove.mock.calls.find(
        ([type]) => type === "pointerdown",
      );
      expect(cleanup?.[1]).toBe(registration?.[1]);
      expect(cleanup?.[2]).toEqual({ capture });
      add.mockRestore();
      remove.mockRestore();
    },
  );

  it("rebinds when capture changes and keeps the latest callback", () => {
    const first = vi.fn();
    const next = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<Harness onOutside={first} />);
    view.rerender(<Harness onOutside={next} capture />);
    const registrations = add.mock.calls.filter(
      ([type]) => type === "pointerdown",
    );
    const removals = remove.mock.calls.filter(
      ([type]) => type === "pointerdown",
    );
    expect(registrations).toHaveLength(2);
    expect(removals).toHaveLength(1);
    expect(removals[0][1]).toBe(registrations[0][1]);
    expect(removals[0][2]).toEqual({ capture: false });
    fireEvent.pointerDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    view.unmount();
    add.mockRestore();
    remove.mockRestore();
  });
});
