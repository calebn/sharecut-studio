import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type RefObject, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

function Harness({
  onOutside,
  enabled = true,
}: {
  onOutside: () => void;
  enabled?: boolean;
}) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  useOutsidePointerDown({ nodes: [panel, trigger], onOutside, enabled });
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
});
