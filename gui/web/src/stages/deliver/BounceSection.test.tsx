import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { defaultModelsWrapper } from "../../test/renderWithModels";
import { BounceSection } from "./BounceSection";
import { BOUNCE_DEFAULTS, type BounceOptions } from "./bounceLogic";

function options(over: Partial<BounceOptions> = {}): BounceOptions {
  return {
    state: { phase: "idle" },
    choices: BOUNCE_DEFAULTS,
    onChoices: vi.fn(),
    selectedCount: 2,
    soloCount: 1,
    hasRegion: true,
    onBounce: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

const SPEAKER = {
  id: "speaker-ecapa",
  variant: null,
  label: "Speaker model",
  purpose: "speaker recognition and split",
  size: "~25 MB",
  sizeBytes: null,
  state: "missing",
};

describe("BounceSection", () => {
  it("offers the three sources with their counts and reports each choice", async () => {
    const user = userEvent.setup();
    const o = options();
    const { container } = render(<BounceSection options={o} />);
    expect(button("Entire mix").getAttribute("aria-pressed")).toBe("true");
    expect(button("Selected tracks (2)").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(button("Soloed tracks (1)")).toBeTruthy();

    await user.click(button("Selected tracks (2)"));
    expect(o.onChoices).toHaveBeenLastCalledWith({
      source: "selected",
      includeMp3: false,
      limitToRegion: false,
    });
    await user.click(button("Also write MP3"));
    expect(o.onChoices).toHaveBeenLastCalledWith({
      source: "entire",
      includeMp3: true,
      limitToRegion: false,
    });
    await user.click(button("Limit to session region"));
    expect(o.onChoices).toHaveBeenLastCalledWith({
      source: "entire",
      includeMp3: false,
      limitToRegion: true,
    });
    await user.click(button("Bounce"));
    expect(o.onBounce).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });

  it("disables the region with its reason when none is set, even if it was chosen", () => {
    render(
      <BounceSection
        options={options({
          hasRegion: false,
          choices: { ...BOUNCE_DEFAULTS, limitToRegion: true },
        })}
      />,
    );
    const region = button("Limit to session region");
    expect(region.hasAttribute("disabled")).toBe(true);
    expect(region.getAttribute("title")).toBe("No session region set.");
    expect(region.getAttribute("aria-pressed")).toBe("false");
  });

  it("gives the reason when the chosen source has no tracks", () => {
    const { rerender } = render(
      <BounceSection
        options={options({
          choices: { ...BOUNCE_DEFAULTS, source: "selected" },
          selectedCount: 0,
        })}
      />,
    );
    expect(button("Bounce").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Select one or more tracks first.")).toBeTruthy();
    rerender(
      <BounceSection
        options={options({
          choices: { ...BOUNCE_DEFAULTS, source: "soloed" },
          soloCount: 0,
        })}
      />,
    );
    expect(screen.getByText("Solo one or more tracks first.")).toBeTruthy();
    rerender(
      <BounceSection
        options={options({
          choices: { ...BOUNCE_DEFAULTS, source: "soloed" },
          soloCount: 3,
        })}
      />,
    );
    expect(button("Bounce").hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("Solo one or more tracks first.")).toBeNull();
  });

  it("shows the host's reason for a Bounce the page cannot start", () => {
    render(
      <BounceSection options={options({ blockedReason: "Host-only." })} />,
    );
    expect(button("Bounce").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Host-only.")).toBeTruthy();
  });

  it("fixes the source to a range chosen in Edit, and lets it go", async () => {
    const user = userEvent.setup();
    const onClearRange = vi.fn();
    render(
      <BounceSection
        options={options({
          fixedRange: "12.00–18.50 s on host",
          onClearRange,
          choices: { ...BOUNCE_DEFAULTS, source: "selected" },
          selectedCount: 0,
        })}
      />,
    );
    expect(
      screen.getByText(
        "Selected range · 12.00–18.50 s on host. This selection is fixed for this bounce.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Source" })).toBeNull();
    expect(screen.queryByText("Limit to session region")).toBeNull();
    expect(button("Also write MP3")).toBeTruthy();
    expect(button("Bounce").hasAttribute("disabled")).toBe(false);
    await user.click(button("Bounce the whole mix instead"));
    expect(onClearRange).toHaveBeenCalledTimes(1);
  });

  it("says the range a bounce is running with is fixed for this bounce", () => {
    render(
      <BounceSection
        options={options({
          fixedRange: "12.00–18.50 s on host",
          rangeIsRunning: true,
          onClearRange: vi.fn(),
          state: { phase: "running", progress: null, detail: "Mixing" },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Selected range · 12.00–18.50 s on host. This selection is fixed for this bounce.",
      ),
    ).toBeTruthy();
  });

  it("says a range fixed during a run is for the next bounce", () => {
    render(
      <BounceSection
        options={options({
          fixedRange: "12.00–18.50 s on host",
          onClearRange: vi.fn(),
          state: { phase: "running", progress: null, detail: "Mixing" },
        })}
      />,
    );
    expect(
      screen.getByText(
        "Selected range · 12.00–18.50 s on host. This selection is fixed for the next bounce.",
      ),
    ).toBeTruthy();
  });

  it("shows the progress, locks Bounce, and cancels", async () => {
    const user = userEvent.setup();
    const o = options({
      state: {
        phase: "running",
        progress: 0.4,
        detail: "Mixing · Elapsed 0:08",
      },
    });
    render(<BounceSection options={o} />);
    expect(screen.getByText("Bouncing")).toBeTruthy();
    expect(screen.getByText("Mixing · Elapsed 0:08")).toBeTruthy();
    expect(button("Bounce").getAttribute("title")).toBe("Bouncing now.");
    expect(screen.queryByText("Bouncing now.")).toBeNull();
    await user.click(button("Cancel"));
    expect(o.onCancel).toHaveBeenCalledTimes(1);
  });

  it("explains a Cancel that cannot run yet, and one that failed", () => {
    render(
      <BounceSection
        options={options({
          state: {
            phase: "running",
            progress: null,
            detail: "Starting bounce…",
            cancelReason:
              "The bounce is still starting. Cancel once it has started.",
            cancelError: "gone",
          },
        })}
      />,
    );
    const cancel = button("Cancel");
    expect(cancel.hasAttribute("disabled")).toBe(true);
    expect(cancel.getAttribute("title")).toBe(
      "The bounce is still starting. Cancel once it has started.",
    );
    expect(screen.getByText("Cancel failed: gone")).toBeTruthy();
  });

  it("names a failure and offers to try again", async () => {
    const user = userEvent.setup();
    const onAgain = vi.fn();
    render(
      <BounceSection
        options={options({
          state: { phase: "failed", cause: "The disk is full." },
          onAgain,
        })}
      />,
    );
    expect(screen.getByText("Bounce failed")).toBeTruthy();
    expect(screen.getByText("The disk is full.")).toBeTruthy();
    await user.click(button("Try again"));
    expect(onAgain).toHaveBeenCalledTimes(1);
  });

  it("says what a cancel left behind", async () => {
    const user = userEvent.setup();
    const onAgain = vi.fn();
    render(
      <BounceSection
        options={options({
          state: {
            phase: "cancelled",
            detail:
              "Cancel came too late. Bounced 1 file(s) to export/bounces/",
            files: ["mix.wav"],
          },
          onAgain,
        })}
      />,
    );
    expect(screen.getByText("Bounce cancelled")).toBeTruthy();
    expect(
      screen.getByText(
        "Cancel came too late. Bounced 1 file(s) to export/bounces/",
      ),
    ).toBeTruthy();
    expect(screen.getByText("mix.wav")).toBeTruthy();
    await user.click(button("Bounce again"));
    expect(onAgain).toHaveBeenCalledTimes(1);
  });

  it("lists what a finished bounce wrote", () => {
    render(
      <BounceSection
        options={options({
          state: {
            phase: "done",
            summary: "Bounced 2 file(s) to export/bounces/",
            files: ["mix.wav", "mix.mp3"],
          },
        })}
      />,
    );
    expect(screen.getByText("Bounced")).toBeTruthy();
    expect(
      screen.getByText("Bounced 2 file(s) to export/bounces/"),
    ).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
      ["mix.wav", "mix.mp3"],
    );
  });

  it("replaces the form with the Model need row while the bounce waits on a model", () => {
    render(
      <BounceSection
        options={options({
          state: { phase: "needs-model", model: SPEAKER },
        })}
      />,
      { wrapper: defaultModelsWrapper },
    );
    expect(screen.queryByRole("button", { name: "Bounce" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Source" })).toBeNull();
    expect(screen.getByText("Needs the speaker model")).toBeTruthy();
    expect(screen.getByText("25 MB")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Get the speaker model" }),
    );
  });

  it("moves focus to Bounce once when asked", () => {
    const onFocused = vi.fn();
    const { rerender } = render(
      <BounceSection options={options({ focusRequested: true, onFocused })} />,
    );
    expect(document.activeElement).toBe(button("Bounce"));
    expect(onFocused).toHaveBeenCalledTimes(1);
    rerender(
      <BounceSection options={options({ focusRequested: true, onFocused })} />,
    );
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it("focuses an enabled control, not the disabled Bounce, when asked", () => {
    const onFocused = vi.fn();
    render(
      <BounceSection
        options={options({
          focusRequested: true,
          onFocused,
          blockedReason: "Not now.",
        })}
      />,
    );
    expect(button("Bounce").hasAttribute("disabled")).toBe(true);
    expect(document.activeElement).toBe(button("Entire mix"));
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it("never lands on the clear-range link when Bounce is disabled", () => {
    const onFocused = vi.fn();
    render(
      <BounceSection
        options={options({
          fixedRange: "12.00–18.50 s on host",
          onClearRange: vi.fn(),
          focusRequested: true,
          onFocused,
          blockedReason: "Not now.",
        })}
      />,
    );
    expect(document.activeElement).toBe(button("Also write MP3"));
    expect(onFocused).toHaveBeenCalledTimes(1);
  });

  it("focuses the Model need row once, not again when the page re-renders", () => {
    const asking = options({ state: { phase: "needs-model", model: SPEAKER } });
    const { rerender } = render(<BounceSection options={asking} />, {
      wrapper: defaultModelsWrapper,
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Get the speaker model" }),
    );
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    rerender(<BounceSection options={{ ...asking }} />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("shows a skeleton while the page loads", () => {
    render(<BounceSection options={options()} state="loading" />);
    expect(screen.queryByRole("button", { name: "Bounce" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bounce" })).toBeTruthy();
  });
});
