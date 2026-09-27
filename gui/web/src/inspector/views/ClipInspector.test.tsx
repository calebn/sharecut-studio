import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, setClipJoin } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { ClipInspector } from "./ClipInspector";

vi.mock("../../api", () => ({
  setClipFade: vi.fn(async () => undefined),
  setClipJoin: vi.fn(async () => undefined),
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

  it("keeps both fades inside the clip", async () => {
    useDawStore.getState().hydrate(
      "/tmp/ep.json",
      minimalProject({
        tracks: [sampleTrack({ role: "music", fade_max_ms: null })],
      }),
    );
    const user = userEvent.setup();
    render(<ClipInspector clip={{ ...clip, source_end: 0.2 }} />);
    const fadeIn = screen.getByLabelText("Fade in ms");
    await user.clear(fadeIn);
    await user.type(fadeIn, "150");
    const fadeOut = screen.getByLabelText("Fade out ms");
    await user.clear(fadeOut);
    await user.type(fadeOut, "150");
    await user.click(screen.getByRole("button", { name: "Apply fades" }));
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 150, 50);
  });

  it("keeps the typed value when the save fails", async () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ fade_max_ms: 40 })] }),
      );
    vi.mocked(setClipFade).mockRejectedValueOnce(new Error("boom"));
    render(<ClipInspector clip={clip} />);
    await applyFades("500");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(500);
    expect(screen.queryByText(/^Clamped/)).toBeNull();
  });

  it("waits for the clip's track before offering Apply", () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ id: "guest" })] }),
      );
    render(<ClipInspector clip={clip} />);
    expect(screen.queryByText(/^max /)).toBeNull();
    expect(screen.getByRole("button", { name: "Apply fades" })).toBeDisabled();
    expect(screen.getByLabelText("Fade in ms")).not.toHaveAttribute("max");
  });

  it("says when it clamped an entry", async () => {
    useDawStore
      .getState()
      .hydrate(
        "/tmp/ep.json",
        minimalProject({ tracks: [sampleTrack({ fade_max_ms: 40 })] }),
      );
    const { rerender } = render(<ClipInspector clip={clip} />);
    await applyFades("500");
    expect(setClipFade).toHaveBeenCalledWith("/tmp/ep.json", "c1", 40, 0);
    rerender(<ClipInspector clip={{ ...clip, fade_in_ms: 40 }} />);
    expect(
      screen.getByText("Clamped to 40 ms in / 0 ms out"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Fade in ms")).toHaveValue(40);
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

describe("ClipInspector join", () => {
  const second: ClipRow = {
    ...clip,
    id: "c2",
    timeline_start: 2,
    timeline_end: 4,
    join_left_clip_id: "c1",
    join_render_mode: "fade",
    join_crossfade_ms: 0,
    join_crossfade_blocked: null,
  };

  beforeEach(() => {
    vi.mocked(setClipJoin).mockClear();
    useDawStore
      .getState()
      .hydrate("/tmp/ep.json", minimalProject({ tracks: [sampleTrack()] }));
  });

  it("hides the join control on a track's first clip", () => {
    render(<ClipInspector clip={{ ...clip, join_left_clip_id: null }} />);
    expect(screen.queryByLabelText("Join mode")).toBeNull();
  });

  it("sets mode and fades together with the typed length", async () => {
    const user = userEvent.setup();
    const { container } = render(<ClipInspector clip={second} />);
    await user.selectOptions(
      screen.getByLabelText("Join mode"),
      "Crossfade (overlap both clips)",
    );
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "crossfade",
      null,
    );
    await user.type(screen.getByLabelText("Join length ms"), "30");
    await user.click(screen.getByRole("button", { name: "Apply length" }));
    expect(setClipJoin).toHaveBeenLastCalledWith(
      "/tmp/ep.json",
      "c1",
      "c2",
      "fade",
      30,
    );
    expect(
      screen.getByRole("button", { name: "Seek join" }).className,
    ).not.toMatch(/link/);
    await expectNoA11yViolations(container);
  });

  it("says why a crossfade will not blend", () => {
    render(
      <ClipInspector
        clip={{
          ...second,
          join_in_mode: "crossfade",
          join_crossfade_blocked: "no_fade_in",
        }}
      />,
    );
    expect(screen.getByText(/no fade-in/)).toBeInTheDocument();
  });

  it("disables fades on a cut join", () => {
    render(<ClipInspector clip={{ ...second, join_in_mode: "cut" }} />);
    expect(screen.getByLabelText("Fade in ms")).toBeDisabled();
    expect(screen.getByLabelText("Fade out ms")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply fades" })).toBeDisabled();
    expect(screen.queryByLabelText("Join length ms")).toBeNull();
    expect(screen.getByText(/hard cut/)).toBeInTheDocument();
  });

  it("rejects a bad length without calling the server", async () => {
    const user = userEvent.setup();
    render(<ClipInspector clip={second} />);
    await user.type(screen.getByLabelText("Join length ms"), "-5");
    await user.click(screen.getByRole("button", { name: "Apply length" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "non-negative integer",
    );
    expect(setClipJoin).not.toHaveBeenCalled();
  });
});
