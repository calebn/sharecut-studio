import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommitRange } from "./useCommitRange";

function Harness({
  saved,
  onCommit,
  lateMount = false,
}: {
  saved: number;
  onCommit: (value: number) => void;
  lateMount?: boolean;
}) {
  const range = useCommitRange({ saved, onCommit });
  const [mounted, setMounted] = useState(!lateMount);
  return (
    <div>
      <span data-testid="value">{range.value}</span>
      {lateMount ? (
        <button type="button" onClick={() => setMounted(true)}>
          Mount
        </button>
      ) : null}
      {mounted ? (
        <input
          aria-label="Len"
          type="range"
          min={0}
          max={100}
          {...range.inputProps}
        />
      ) : null}
      <button type="button" onClick={() => range.commitValue(0)}>
        Reset
      </button>
    </div>
  );
}

describe("useCommitRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves the value locally on input without committing", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits once on native change", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "30" } });
    fireEvent.change(input, { target: { value: "30" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(30);
  });

  it("does not commit a change equal to saved", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.change(input, { target: { value: "10" } });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows a new saved value when idle", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Harness saved={10} onCommit={onCommit} />);
    rerender(<Harness saved={50} onCommit={onCommit} />);
    expect(screen.getByTestId("value")).toHaveTextContent("50");
  });

  it("ignores a new saved value mid-drag, then follows the next one", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    rerender(<Harness saved={20} onCommit={onCommit} />);
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    fireEvent.pointerUp(input);
    rerender(<Harness saved={60} onCommit={onCommit} />);
    expect(screen.getByTestId("value")).toHaveTextContent("60");
  });

  it("returns the thumb to saved when the drag is cancelled before a change", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    fireEvent.pointerCancel(input);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores the change WebKit fires after a pointer cancel", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.pointerCancel(input);
    (input as HTMLInputElement).value = "40";
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores the change fired when the page is backgrounded mid-drag, then commits the next drag", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockRestore();
    (input as HTMLInputElement).value = "40";
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "70" } });
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(70);
  });

  it("keeps the drag when the page becomes visible mid-drag", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });

  it("ignores a change that arrives while the page is already hidden", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    visibility.mockRestore();
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("returns the thumb to saved on pagehide mid-drag and ignores its change", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent(window, new Event("pagehide"));
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    (input as HTMLInputElement).value = "40";
    act(() => {
      input.dispatchEvent(new Event("change"));
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a release whose blur arrives just before its change", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.blur(input);
    act(() => {
      input.dispatchEvent(new Event("change"));
      vi.runAllTimers();
    });
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });

  it("does not revert a new drag that starts before a pending revert fires", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.blur(input);
    fireEvent.input(input, { target: { value: "55" } });
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId("value")).toHaveTextContent("55");
  });

  it("returns the thumb to saved when focus leaves mid-drag", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.blur(input);
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByTestId("value")).toHaveTextContent("10");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps a committed value through release and blur while the save is pending", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.pointerUp(input);
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("value")).toHaveTextContent("40");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(40);
  });

  it("commitValue sets the value and commits", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByTestId("value")).toHaveTextContent("0");
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it("still commits on change for an input that mounts after the first render", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} lateMount />);
    fireEvent.click(screen.getByRole("button", { name: "Mount" }));
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.change(input, { target: { value: "25" } });
    expect(onCommit).toHaveBeenCalledWith(25);
  });
});

describe("useCommitRange with a second pointer (#1034)", () => {
  // The hook keeps no pointer identity: any pointerup ends its drag-lock, so
  // this pins only that the native change still commits the dragged value once.
  it("commits the dragged value once when another pointer's lift lands mid-drag", () => {
    const onCommit = vi.fn();
    render(<Harness saved={10} onCommit={onCommit} />);
    const input = screen.getByRole("slider", { name: "Len" });
    fireEvent.pointerDown(input, { pointerId: 1 });
    fireEvent.input(input, { target: { value: "40" } });
    fireEvent.pointerDown(input, { pointerId: 2 });
    fireEvent.pointerUp(input, { pointerId: 2 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(input, { pointerId: 1 });
    fireEvent.change(input, { target: { value: "40" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(40);
  });
});
