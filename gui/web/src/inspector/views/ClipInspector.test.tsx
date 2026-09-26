import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { ClipInspector } from "./ClipInspector";

vi.mock("../../api", () => ({
  setClipFade: vi.fn(async () => undefined),
  setJoinMode: vi.fn(async () => undefined),
  applyFadeRecommendations: vi.fn(async () => undefined),
}));

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 2,
  timeline_start: 0,
  timeline_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

async function applyFades(value: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Fade in ms");
  await user.clear(input);
  await user.type(input, value);
  await user.click(screen.getByRole("button", { name: "Apply fades" }));
}

describe("ClipInspector fades", () => {
  beforeEach(() => {
    vi.mocked(setClipFade).mockClear();
  });

  it("clamps to the dialogue track's cap and has no axe violations", async () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ fade_max_ms: 40 })] }),
      );
    const { container } = render(<ClipInspector clip={clip} />);
    expect(screen.getByLabelText("Fade in ms")).toHaveAttribute("max", "40");
    expect(screen.getByText("max 40 ms")).toBeInTheDocument();
    await applyFades("500");
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 40, 0);
    await expectNoA11yViolations(container);
  });

  it("clamps an uncapped track to the clip length", async () => {
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [sampleTrack({ role: "music", fade_max_ms: null })],
      }),
    );
    render(<ClipInspector clip={{ ...clip, source_end: 0.2 }} />);
    await applyFades("500");
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 200, 0);
  });

  it("no longer offers a track-wide fade button", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
    render(<ClipInspector clip={clip} />);
    expect(
      screen.queryByRole("button", {
        name: /recommended fades|smooth all joins/i,
      }),
    ).toBeNull();
  });
});
