import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHoldRepeat } from "./useHoldRepeat";

function HoldButton() {
  const hold = useHoldRepeat(() => false);
  return (
    <button type="button" {...hold}>
      Hold me
    </button>
  );
}

function rule(css: string, selector: string): string {
  const match = css.match(
    new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`),
  );
  return match?.[1] ?? "";
}

describe("useHoldRepeat control styling", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps an active hold on its cadence with the latest callback and cancels on unmount", () => {
    vi.useFakeTimers();
    const first = vi.fn(() => true);
    const next = vi.fn(() => true);
    function Button({ step }: { step: () => boolean }) {
      return (
        <button type="button" {...useHoldRepeat(step)}>
          Step
        </button>
      );
    }
    const view = render(<Button step={first} />);
    fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
    expect(first).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    view.rerender(<Button step={next} />);
    vi.advanceTimersByTime(99);
    expect(next).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(next).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(next).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.advanceTimersByTime(1000);
    expect(next).toHaveBeenCalledTimes(2);
  });
  it("marks every hold-to-repeat button with the shared class, so no caller styles it", () => {
    render(<HoldButton />);
    expect(screen.getByRole("button", { name: "Hold me" })).toHaveClass(
      "hold-repeat",
    );
  });

  it("keeps iOS from selecting the label or opening the loupe on a held press", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(
      join(here, "../styles/partials/layout.css"),
      "utf8",
    );
    const body = rule(css, ".hold-repeat");
    expect(body).toMatch(/user-select:\s*none/);
    expect(body).toMatch(/-webkit-user-select:\s*none/);
    expect(body).toMatch(/-webkit-touch-callout:\s*none/);
  });
});
