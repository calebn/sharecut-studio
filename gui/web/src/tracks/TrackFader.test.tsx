import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { TrackFader } from "./TrackFader";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

const host: TrackView = {
  id: "host",
  label: "Host",
  role: "dialogue",
  speaker: null,
  gain_db: -2,
  fader_db: -3,
  muted: false,
  duration_sec: 60,
  fx_count: 0,
  stem_is_fresh: true,
};

function renderFader(
  opts: { projectPath?: string; shareCapabilities?: string[] | null } = {},
) {
  const project = minimalProject({ tracks: [host] });
  const view = render(
    <DawProvider
      projectPath={opts.projectPath ?? "/tmp/p.json"}
      initialProject={project}
      shareCapabilities={opts.shareCapabilities ?? null}
    >
      <FaderFromStore />
    </DawProvider>,
  );
  return { ...view, slider: screen.getByRole("slider", { name: "Volume" }) };
}

/** Reads the track from the store, as the inspector does. */
function FaderFromStore() {
  const track = useDawStore((s) => s.project?.tracks[0]);
  return track ? <TrackFader track={track} /> : null;
}

describe("TrackFader (#386)", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
  });

  it("shows the saved volume and what the track plays at", async () => {
    const { slider, container } = renderFader();
    expect(slider).toHaveValue("-3");
    expect(slider).toHaveAttribute("aria-valuetext", "−3.0 dB");
    expect(screen.getByText(/plays at −5\.0 dB/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("moves locally while dragging and commits once on change", () => {
    const { slider } = renderFader();
    fireEvent.input(slider, { target: { value: "-6" } });
    expect(slider).toHaveValue("-6");
    expect(execute).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: "-6" } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "track.setVolume",
      { trackId: "host", db: -6 },
      { skipWhen: true },
    );
  });

  it("resets to 0 dB on double-click", () => {
    const { slider } = renderFader();
    fireEvent.doubleClick(slider);
    expect(execute).toHaveBeenCalledWith(
      "track.setVolume",
      { trackId: "host", db: 0 },
      { skipWhen: true },
    );
    expect(slider).toHaveValue("0");
  });

  it("follows the saved value (undo, a collaborator)", () => {
    const { slider } = renderFader();
    act(() => {
      const project = useDawStore.getState().project;
      if (project) {
        useDawStore.getState().setProject({
          ...project,
          tracks: [{ ...host, fader_db: 1.5 }],
        });
      }
    });
    expect(slider).toHaveValue("1.5");
  });

  it("is read-only for guests without edit", () => {
    const { slider } = renderFader({
      projectPath: "share:tok",
      shareCapabilities: ["view", "suggest"],
    });
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute(
      "title",
      "Only the host and editors can change the volume",
    );
  });
});
