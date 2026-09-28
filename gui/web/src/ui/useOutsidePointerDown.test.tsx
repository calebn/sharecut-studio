import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

function Harness({
  onOutside,
  enabled = true,
}: {
  onOutside: () => void;
  enabled?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useOutsidePointerDown([panelRef, triggerRef], onOutside, enabled);
  return (
    <div>
      <button ref={triggerRef} type="button">
        Trigger
      </button>
      <div ref={panelRef} data-testid="panel">
        <span>Inside</span>
      </div>
      <p>Outside</p>
    </div>
  );
}

describe("useOutsidePointerDown", () => {
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
