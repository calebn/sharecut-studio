import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { TrackMuteSoloButtons } from "./TrackMuteSoloButtons";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function track(id: string, muted = false): TrackView {
  return {
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    fader_db: 0,
    muted,
    duration_sec: 60,
    fx_count: 0,
    stem_is_fresh: true,
  };
}

function renderButtons({
  muted = false,
  projectPath = "/tmp/p.json",
  shareCapabilities = null as string[] | null,
  viewerMute = {} as Record<string, boolean>,
  soloTracks = {} as Record<string, boolean>,
} = {}) {
  const project = minimalProject({
    tracks: [track("host", muted), track("guest")],
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
      "Muted in the mix, for everyone and every export",
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
    expect(mute).toHaveAttribute("title", "Muted for you only");
    await expectNoA11yViolations(container);
  });

  it("shows a track silenced by your solo as an implied mute", () => {
    const { mute, solo } = renderButtons({ soloTracks: { guest: true } });
    expect(mute).toHaveAttribute("data-mute-state", "implied");
    expect(mute).toHaveAttribute("aria-pressed", "false");
    expect(mute).toHaveAttribute("title", "Silenced by your solo");
    expect(solo).toHaveAttribute("title", "Solo for you only");
  });

  it("marks solo as listen-only", () => {
    const { mute, solo } = renderButtons({ soloTracks: { host: true } });
    expect(solo).toHaveAttribute("aria-pressed", "true");
    expect(solo).toHaveAttribute("title", "Soloed for you only");
    expect(mute).toHaveAttribute("data-mute-state", "off");
    expect(mute).toHaveAttribute("title", "Mute in the mix");
  });
});
