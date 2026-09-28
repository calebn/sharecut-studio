import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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
