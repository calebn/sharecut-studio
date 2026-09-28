import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { shareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject } from "../../test/fixtures";
import type { TrackView } from "../../types/project";
import { GUESTS_HEAR_FULL_MIX } from "../../utils/auditionModes";
import { TrackInspector } from "./TrackInspector";

const setTrackMetaCommand = vi.fn();
const applyFadeRecommendations = vi.fn(
  async (..._args: unknown[]) => undefined,
);

vi.mock("../../api", () => ({
  setTrackMetaCommand: (...args: unknown[]) => setTrackMetaCommand(...args),
  setEffectBypass: vi.fn(),
  applyFadeRecommendations: (...args: unknown[]) =>
    applyFadeRecommendations(...args),
}));

const hostTrack: TrackView = {
  id: "host",
  label: "Host",
  role: "dialogue",
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 10,
  fx_count: 0,
  stem_is_fresh: true,
};

describe("TrackInspector", () => {
  beforeEach(() => {
    setTrackMetaCommand.mockReset();
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [hostTrack] }));
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("names its native fields and is axe-clean", async () => {
    const { container } = render(
      <TrackInspector track={hostTrack} effects={[]} />,
    );
    expect(screen.getByRole("textbox", { name: "Track label" })).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Track speaker" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Track role" })).toBeVisible();
    await expectNoA11yViolations(container);
  });

  it("applies SetTrackMeta locally before the command resolves and reverts on failure", async () => {
    const user = userEvent.setup();
    let release!: (err?: Error) => void;
    const held = new Promise<Record<string, unknown>>((_, reject) => {
      release = (err?: Error) => {
        reject(err ?? new Error("network"));
      };
    });
    setTrackMetaCommand.mockImplementation(async () => held);

    render(<TrackInspector track={hostTrack} effects={[]} />);
    const input = screen.getByDisplayValue("Host");
    await user.clear(input);
    await user.type(input, "Narrator");
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    await user.tab();
    expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Narrator");
    expect(setTrackMetaCommand).toHaveBeenCalled();

    release(new Error("network"));
    await vi.waitFor(() => {
      expect(useDawStore.getState().project?.tracks[0]?.label).toBe("Host");
    });
  });

  it("does not switch a guest to FX via Preview effects at track start", async () => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [hostTrack] }), "view");
    render(<TrackInspector track={hostTrack} effects={[]} />);
    const playFx = screen.getByRole("button", {
      name: "Preview effects at track start",
    });
    expect(playFx).toBeDisabled();
    expect(playFx).toHaveAttribute("title", GUESTS_HEAR_FULL_MIX);
    expect(await execute("transport.audition", { mode: "fx" })).toEqual({
      status: "disabled",
      reason: GUESTS_HEAR_FULL_MIX,
    });
    expect(useDawStore.getState().auditionMode).toBe("mix");
  });

  it("Go to start moves the playhead to 0", async () => {
    const user = userEvent.setup();
    useDawStore.getState().setPlayheadSec(5);
    render(<TrackInspector track={hostTrack} effects={[]} />);
    await user.click(screen.getByRole("button", { name: "Go to start" }));
    expect(useDawStore.getState().playheadSec).toBe(0);
  });

  it("stem freshness reads Up to date / Out of date / Unknown", () => {
    const { rerender } = render(
      <TrackInspector
        track={{ ...hostTrack, stem_is_fresh: true }}
        effects={[]}
      />,
    );
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    rerender(
      <TrackInspector
        track={{ ...hostTrack, stem_is_fresh: false }}
        effects={[]}
      />,
    );
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    rerender(
      <TrackInspector
        track={{ ...hostTrack, stem_is_fresh: null }}
        effects={[]}
      />,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("effect params read as text, not JSON", async () => {
    const { container } = render(
      <TrackInspector
        track={hostTrack}
        effects={[
          {
            effect: "acompressor",
            params: { threshold_db: -18, ratio: 3 },
          },
        ]}
      />,
    );
    expect(screen.getByText("threshold -18 dB · ratio 3")).toBeInTheDocument();
    expect(container.textContent).not.toContain("{");
    await expectNoA11yViolations(container);
  });

  it("passes the effect name so per-effect units apply", () => {
    render(
      <TrackInspector
        track={hostTrack}
        effects={[{ effect: "deesser", params: { frequency: 0.5 } }]}
      />,
    );
    expect(screen.getByText("frequency (0–1) 0.5")).toBeInTheDocument();
    expect(screen.queryByText(/0\.5 Hz/)).toBeNull();
  });

  it("smooths every join on the track from the track inspector", async () => {
    const user = userEvent.setup();
    render(<TrackInspector track={hostTrack} effects={[]} />);
    await user.click(
      screen.getByRole("button", { name: "Smooth all joins on this track" }),
    );
    expect(applyFadeRecommendations).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "host",
    );
  });

  it("hides the smooth-joins button from a guest without edit", () => {
    useDawStore
      .getState()
      .hydrate(
        shareProjectKey("tok"),
        minimalProject({ tracks: [hostTrack] }),
        "view",
      );
    render(<TrackInspector track={hostTrack} effects={[]} />);
    expect(
      screen.queryByRole("button", { name: /smooth all joins/i }),
    ).toBeNull();
  });
});
