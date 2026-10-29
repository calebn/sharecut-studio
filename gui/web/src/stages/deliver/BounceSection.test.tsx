import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelGate } from "../../models";
import { expectNoA11yViolations } from "../../test/a11y";
import { registryModels } from "../../test/modelsStory";
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

function gate(over: Partial<ModelGate> = {}): ModelGate {
  return {
    run: vi.fn(),
    prompt: null,
    declined: null,
    accept: vi.fn(),
    decline: vi.fn(),
    cancelDownload: vi.fn(),
    openModels: vi.fn(),
    reset: vi.fn(),
    ...over,
  };
}

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

  it("replaces the form and the run state with the model prompt while it asks", () => {
    const view = registryModels({ "speaker-ecapa": { kind: "missing" } })[3];
    render(
      <BounceSection
        options={options({
          state: { phase: "running", progress: null, detail: "Starting…" },
          gate: gate({
            prompt: {
              need: { id: view.id },
              label: view.label,
              purpose: view.purpose,
              size: view.size,
              phase: "ask",
              view,
              blockedReason: undefined,
            },
          }),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Bounce" })).toBeNull();
    expect(screen.queryByText("Bouncing")).toBeNull();
    expect(screen.queryByRole("group", { name: "Source" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Download" }),
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

  it("focuses the model prompt once, not on each phase change", () => {
    const view = registryModels({ "speaker-ecapa": { kind: "missing" } })[3];
    const asking = (phase: "ask" | "failed") =>
      options({
        gate: gate({
          prompt: {
            need: { id: view.id },
            label: view.label,
            purpose: view.purpose,
            size: view.size,
            phase,
            view,
            blockedReason: undefined,
          } as never,
        }),
      });
    const { rerender } = render(<BounceSection options={asking("ask")} />);
    expect(document.activeElement).toBe(screen.getAllByRole("button")[0]);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    rerender(<BounceSection options={asking("failed")} />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("shows a skeleton while the page loads", () => {
    render(<BounceSection options={options()} state="loading" />);
    expect(screen.queryByRole("button", { name: "Bounce" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bounce" })).toBeTruthy();
  });
});
