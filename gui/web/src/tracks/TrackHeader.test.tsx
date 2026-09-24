import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { TrackHeader } from "./TrackHeader";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function projectWithTrack() {
  return minimalProject({
    tracks: [
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: null,
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
  });
}

describe("TrackHeader", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", projectWithTrack());
  });

  it("selects the track when the full header row is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const project = projectWithTrack();
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <div className="daw-shell daw-shell--phone">
          <TrackHeader
            track={project.tracks[0]}
            trackIndex={0}
            selected={false}
            onSelect={onSelect}
          />
        </div>
      </DawProvider>,
    );
    const details = screen.getByRole("button", {
      name: /Open track details, Guest/i,
    });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(
      container.querySelector(".daw-shell--phone .track-header-disclose"),
    ).toBeTruthy();
    await user.click(details);
    expect(onSelect).toHaveBeenCalledWith(false);
  });

  it("a touch long-press selects the track once and consumes the click", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const project = projectWithTrack();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={project.tracks[0]}
          trackIndex={0}
          selected={false}
          onSelect={onSelect}
        />
      </DawProvider>,
    );
    const details = screen.getByRole("button", {
      name: /Open track details, Guest/i,
    });
    const touch = { pointerType: "touch", isPrimary: true, pointerId: 1 };
    fireEvent.pointerDown(details, touch);
    vi.advanceTimersByTime(600);
    fireEvent.pointerUp(details, touch);
    fireEvent.click(details, { shiftKey: true });
    vi.runOnlyPendingTimers();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(false);
    vi.useRealTimers();
  });

  it("marks the open control expanded when the row is selected", () => {
    const project = projectWithTrack();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={project.tracks[0]}
          trackIndex={0}
          selected
          onSelect={() => undefined}
        />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Open track details, Guest/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("uses the lane color for the track identity bar", () => {
    const project = projectWithTrack();
    const track = { ...project.tracks[0], role: "music" as const };
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={track}
          trackIndex={0}
          selected={false}
          onSelect={() => undefined}
        />
      </DawProvider>,
    );
    expect(container.querySelector(".track-header-row")).toHaveStyle({
      "--track-identity-color": "var(--clip-music)",
    });
  });

  it("shows a single FX badge with its effect-count title", () => {
    const project = projectWithTrack();
    const track = { ...project.tracks[0], fx_count: 2 };
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={track}
          trackIndex={0}
          selected={false}
          onSelect={() => undefined}
        />
      </DawProvider>,
    );

    const badge = screen.getByTitle("2 effects");
    expect(badge).toHaveClass("badge", "fx");
    expect(badge).toHaveTextContent("FX 2");
  });

  it("does not select when Mute is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const project = projectWithTrack();
    const { execute } = await import("../commands/execute");
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={project.tracks[0]}
          trackIndex={0}
          selected={false}
          onSelect={onSelect}
        />
      </DawProvider>,
    );
    await user.click(screen.getByTitle("Mute"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      "track.muteToggle",
      { trackId: "guest" },
      { skipWhen: true },
    );
    expect(
      screen.getByTitle("Mute").closest("[data-presence-anchor]"),
    ).toHaveAttribute("data-presence-anchor", "track:guest:mute");
  });

  it("exposes the reorder grip as a drag handle, not a button", () => {
    const project = projectWithTrack();
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={project.tracks[0]}
          trackIndex={0}
          selected
          onSelect={() => undefined}
          reorderEnabled
        />
      </DawProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Reorder track Guest/i }),
    ).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: /Reorder track Guest/i }),
    ).toHaveAttribute("aria-roledescription", "drag handle");
  });

  it("shows no stem dot for a new track with no audio, matching the status bar", () => {
    const project = minimalProject({
      tracks: [
        {
          id: "empty",
          label: "Empty",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 0,
          fx_count: 0,
          stem_is_fresh: false,
        },
      ],
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackHeader
          track={project.tracks[0]}
          trackIndex={0}
          selected={false}
          onSelect={() => undefined}
        />
      </DawProvider>,
    );
    expect(container.querySelector(".stem-dot")).toBeNull();
  });
});
