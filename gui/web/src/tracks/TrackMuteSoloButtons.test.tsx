import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TrackMuteSoloButtons } from "./TrackMuteSoloButtons";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function renderButtons({
  muted = false,
  projectPath = "/tmp/p.json",
  shareCapabilities = null as string[] | null,
  viewerMute = {} as Record<string, boolean>,
  soloTracks = {} as Record<string, boolean>,
} = {}) {
  const project = minimalProject({
    tracks: [sampleTrack({ id: "host", muted }), sampleTrack({ id: "guest" })],
  });
  const view = render(
    <DawProvider
      projectPath={projectPath}
      initialProject={project}
      shareCapabilities={shareCapabilities}
    >
      <div role="group" aria-label="Host mixer">
        <TrackMuteSoloButtons trackId="host" />
      </div>
    </DawProvider>,
  );
  act(() => {
    useDawStore.setState({ viewerMute, soloTracks });
  });
  const [mute, solo] = screen.getAllByRole("button");
  return { ...view, mute, solo };
}

describe("TrackMuteSoloButtons (#386)", () => {
  it("shows the host a solid saved mute they can change", async () => {
    const { mute, container } = renderButtons({ muted: true });
    expect(mute).toHaveAttribute("data-mute-state", "saved");
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(mute).not.toHaveAttribute("aria-disabled");
    expect(mute).toHaveAttribute(
      "title",
      "Unmute (M). Muted in the mix, for everyone and every export",
    );
    expect(mute.className).not.toContain("mute-listen");
    await expectNoA11yViolations(container);
  });

  it("shows a view guest the saved mute read-only", () => {
    const { mute } = renderButtons({
      muted: true,
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    expect(mute).toHaveAttribute("data-mute-state", "saved");
    expect(mute).toHaveAttribute("aria-disabled", "true");
    expect(mute.title).toContain("Only the host and editors can unmute it");
  });

  it("dashes a guest's listen-only mute", async () => {
    const { mute, container } = renderButtons({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
      viewerMute: { host: true },
    });
    expect(mute).toHaveAttribute("data-mute-state", "listen");
    expect(mute).toHaveAttribute("aria-pressed", "true");
    expect(mute.className).toContain("mute-listen");
    expect(mute).toHaveAttribute("title", "Unmute (M). Muted for you only");
    await expectNoA11yViolations(container);
  });

  it("shows a track silenced by your solo as an implied mute", () => {
    const { mute, solo } = renderButtons({ soloTracks: { guest: true } });
    expect(mute).toHaveAttribute("data-mute-state", "implied");
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(mute).toHaveAccessibleDescription(
      "Mute (M). Not muted: silent because you soloed another track, and only you hear it that way",
    );
    expect(solo).toHaveAttribute(
      "title",
      "Solo (S). Solos the track for you only",
    );
  });

  it("keeps a saved mute saved while you solo that track", () => {
    const { mute } = renderButtons({ muted: true, soloTracks: { host: true } });
    expect(mute).toHaveAttribute("data-mute-state", "saved");
    expect(mute).toHaveAttribute("aria-pressed", "true");
  });

  it("marks solo as listen-only", () => {
    const { mute, solo } = renderButtons({ soloTracks: { host: true } });
    expect(solo).toHaveAttribute("aria-pressed", "true");
    expect(solo).toHaveAttribute("title", "Unsolo (S). Soloed for you only");
    expect(mute).toHaveAttribute("data-mute-state", "off");
    expect(mute).toHaveAttribute(
      "title",
      "Mute (M). Mutes the track in the mix, for everyone",
    );
  });

  it("names M and S after the track", async () => {
    const project = minimalProject({
      tracks: [sampleTrack({ id: "host", label: "Caleb" })],
    });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TrackMuteSoloButtons trackId="host" />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({ viewerMute: {}, soloTracks: {} });
    });
    const mute = screen.getByRole("button", { name: "Mute Caleb" });
    const solo = screen.getByRole("button", { name: "Solo Caleb" });
    expect(mute.title.startsWith("Mute (M)")).toBe(true);
    expect(solo.title.startsWith("Solo (S)")).toBe(true);
    await expectNoA11yViolations(container);
  });

  it("gives a guest a listen-only off tooltip", () => {
    const { mute } = renderButtons({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    expect(mute).toHaveAttribute("data-mute-state", "off");
    expect(mute).toHaveAttribute(
      "title",
      "Mute (M). Mutes the track for you only",
    );
  });
});
