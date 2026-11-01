import { fireEvent, render, screen } from "@testing-library/react";
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

const excluded = () =>
  ["readiness", "transcript", "chapters", "other-column"].map((id) =>
    screen.getByTestId(id),
  );
const anchorValues = () =>
  excluded().map((el) => el.style.getPropertyValue("overflow-anchor"));
const running: BounceState = {
  phase: "running",
  progress: null,
  detail: "Starting bounce…",
  cancelReason: "Still starting.",
};

describe("Bounce native anchor ownership", () => {
  it("seeds only other page branches before the existing command and keeps the real running-row order", async () => {
    const value = options();
    const commandSaw: string[][] = [];
    value.onBounce = vi.fn(() => commandSaw.push(anchorValues()));
    const view = render(<Surface value={value} />);
    const original = screen.getByRole("button", {
      name: /^Bounce$/,
    });
    await userEvent.click(original);
    expect(value.onBounce).toHaveBeenCalledTimes(1);
    expect(commandSaw).toEqual([["none", "none", "none", "none"]]);
    expect(screen.getByTestId("page").style.overflowAnchor).toBe("");
    expect(original.closest("section")!.style.overflowAnchor).toBe("");
    view.rerender(<Surface value={{ ...value, state: running }} />);
    expect(screen.getByRole("button", { name: /^Bounce$/ })).toBe(original);
    expect(original.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Cancel" })
        .compareDocumentPosition(original) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("stage"));
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
  });

  it("hands off on any first scroll, including one already queued, and never rearms on progress", async () => {
    const value = options();
    const view = render(<Surface value={value} />);
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
    fireEvent.scroll(screen.getByTestId("page"));
    expect(anchorValues()).toEqual(["", "", "", ""]);
    view.rerender(<Surface value={{ ...value, state: running }} />);
    view.rerender(
      <Surface value={{ ...value, state: { ...running, progress: 0.5 } }} />,
    );
    expect(anchorValues()).toEqual(["", "", "", ""]);
  });

  it.each(["pointerdown", "wheel", "touchstart", "keydown"])(
    "hands off before %s navigation",
    async (type) => {
      render(<Surface value={options()} />);
      await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
      expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
      fireEvent(
        screen.getByRole("button", { name: "Read transcript" }),
        new Event(type, { bubbles: true }),
      );
      expect(anchorValues()).toEqual(["", "", "", ""]);
    },
  );

  it.each(["Read transcript", "App chrome"])(
    "restores the reader's normal page when focus leaves for %s",
    async (name) => {
      render(<Surface value={options()} />);
      await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
      expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
      screen.getByRole("button", { name }).focus();
      expect(document.activeElement).toBe(screen.getByRole("button", { name }));
      expect(anchorValues()).toEqual(["", "", "", ""]);
    },
  );

  it("restores prior values but preserves another owner's intervening style", async () => {
    render(<Surface value={options()} />);
    const transcript = screen.getByTestId("transcript");
    transcript.style.setProperty("overflow-anchor", "auto", "important");
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(transcript.style.getPropertyValue("overflow-anchor")).toBe("none");
    expect(transcript.style.getPropertyPriority("overflow-anchor")).toBe("");
    fireEvent.scroll(screen.getByTestId("page"));
    expect(transcript.style.getPropertyValue("overflow-anchor")).toBe("auto");
    expect(transcript.style.getPropertyPriority("overflow-anchor")).toBe(
      "important",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(transcript.style.getPropertyValue("overflow-anchor")).toBe("none");
    expect(transcript.style.getPropertyPriority("overflow-anchor")).toBe("");
    transcript.style.setProperty("overflow-anchor", "none", "important");
    fireEvent.scroll(screen.getByTestId("page"));
    expect(transcript.style.getPropertyValue("overflow-anchor")).toBe("none");
    expect(transcript.style.getPropertyPriority("overflow-anchor")).toBe(
      "important",
    );
    expect(screen.getByTestId("readiness").style.overflowAnchor).toBe("");
  });

  it.each<BounceState>([
    { phase: "done", files: [], summary: "Done" },
    { phase: "cancelled", files: [], detail: "Cancelled" },
    { phase: "failed", cause: "Failed" },
    { phase: "idle" },
  ])("releases on settlement $phase", async (state) => {
    const value = options();
    const view = render(<Surface value={value} />);
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    view.rerender(<Surface value={{ ...value, state: running }} />);
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
    view.rerender(<Surface value={{ ...value, state }} />);
    expect(anchorValues()).toEqual(["", "", "", ""]);
  });

  it("releases a start that fails before running is ever rendered", async () => {
    const value = options();
    const view = render(<Surface value={value} />);
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
    view.rerender(
      <Surface
        value={{
          ...value,
          state: { phase: "failed", cause: "Could not start" },
        }}
      />,
    );
    expect(anchorValues()).toEqual(["", "", "", ""]);
  });

  it.each(["idle", "running"] as const)(
    "releases a start when the page returns to loading while %s",
    async (phase) => {
      const value = options();
      const view = render(
        <div className="dv-stage">
          <section className="dv-page">
            <div data-testid="sibling">Readiness</div>
            <BounceSection options={value} />
          </section>
        </div>,
      );
      await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
      expect(screen.getByTestId("sibling").style.overflowAnchor).toBe("none");
      view.rerender(
        <div className="dv-stage">
          <section className="dv-page">
            <div data-testid="sibling">Readiness</div>
            <BounceSection
              options={{
                ...value,
                state: phase === "running" ? running : value.state,
              }}
              state="loading"
            />
          </section>
        </div>,
      );
      expect(screen.getByTestId("sibling").style.overflowAnchor).toBe("");
    },
  );

  it("releases on project-key replacement without seeding its background run", async () => {
    const value = options();
    const view = render(<Surface value={value} />);
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
    view.rerender(
      <Surface episode="replacement" value={{ ...value, state: running }} />,
    );
    expect(anchorValues()).toEqual(["", "", "", ""]);
    expect(value.onBounce).toHaveBeenCalledTimes(1);
  });

  it("restores styles on unmount and does not alter the page when it mounts already running", async () => {
    const value = options();
    const view = render(<Surface value={value} />);
    await userEvent.click(screen.getByRole("button", { name: /^Bounce$/ }));
    const previous = excluded();
    expect(anchorValues()).toEqual(["none", "none", "none", "none"]);
    view.unmount();
    expect(previous.map((el) => el.style.overflowAnchor)).toEqual([
      "",
      "",
      "",
      "",
    ]);
    render(<Surface value={{ ...value, state: running }} />);
    expect(anchorValues()).toEqual(["", "", "", ""]);
  });
});
