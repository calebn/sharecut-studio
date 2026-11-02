import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BounceSection } from "./BounceSection";
import {
  BOUNCE_DEFAULTS,
  type BounceOptions,
  type BounceState,
} from "./bounceLogic";
import { useFocusRecovery } from "./useFocusRecovery";

function options(): BounceOptions {
  return {
    state: { phase: "idle" },
    choices: BOUNCE_DEFAULTS,
    onChoices: vi.fn(),
    selectedCount: 2,
    soloCount: 0,
    hasRegion: true,
    onBounce: vi.fn(),
    onCancel: vi.fn(),
  };
}

function Surface({
  value,
  episode = "first",
}: {
  value: BounceOptions;
  episode?: string;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useFocusRecovery(root);
  return (
    <>
      <button>App chrome</button>
      <div className="dv-stage" ref={setRoot} tabIndex={-1} data-testid="stage">
        <section className="dv-page" data-testid="page">
          <div data-testid="readiness">Readiness</div>
          <div className="dv-columns">
            <div className="dv-col">
              <section data-testid="transcript">
                <button>Read transcript</button>
              </section>
              <BounceSection key={episode} options={value} />
              <section data-testid="chapters">Chapters</section>
            </div>
            <div className="dv-col" data-testid="other-column">
              Share
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

const running: BounceState = {
  phase: "running",
  progress: null,
  detail: "Starting bounce…",
  cancelReason: "Still starting.",
};

describe("Bounce run lifecycle", () => {
  it("keeps the original disabled button below the new running row and recovers focus to the stage", async () => {
    const value = options();
    const view = render(<Surface value={value} />);
    const original = screen.getByRole("button", { name: /^Bounce$/ });
    await userEvent.click(original);
    expect(value.onBounce).toHaveBeenCalledOnce();
    view.rerender(<Surface value={{ ...value, state: running }} />);
    expect(screen.getByRole("button", { name: /^Bounce$/ })).toBe(original);
    expect(original).toBeDisabled();
    expect(
      screen
        .getByRole("button", { name: "Cancel" })
        .compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("stage"));
  });
  it("keeps reader focus and does not restart a background run through progress and keyed replacement", () => {
    const value = { ...options(), state: running };
    const view = render(<Surface value={value} />);
    const reader = screen.getByRole("button", { name: "Read transcript" });
    reader.focus();
    view.rerender(
      <Surface value={{ ...value, state: { ...running, progress: 0.5 } }} />,
    );
    expect(document.activeElement).toBe(reader);
    expect(value.onBounce).not.toHaveBeenCalled();
    view.rerender(<Surface episode="replacement" value={value} />);
    expect(document.activeElement).toBe(reader);
    expect(value.onBounce).not.toHaveBeenCalled();
  });
});
