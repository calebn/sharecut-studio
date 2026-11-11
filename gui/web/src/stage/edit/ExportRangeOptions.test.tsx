import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { useDawStore } from "../../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../../test/fixtures";
import { ExportRangeOptions } from "./ExportRangeOptions";
import { EXPORT_RANGE_STORAGE_KEY } from "./exportRange";

const tracks = [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })];
const project = minimalProject({
  tracks,
  clips: {
    tracks: Object.fromEntries(
      tracks.map((t) => [t.id, [clipRow({ id: `${t.id}-1`, track_id: t.id })]]),
    ),
    clip_count: 2,
  },
});

function selectRange() {
  useDawStore.setState({
    project,
    selection: {
      kind: "range",
      target: makeRangeTarget(project, [{ start: 1, end: 5 }], ["host"])!,
    },
  });
}

const stored = () => localStorage.getItem(EXPORT_RANGE_STORAGE_KEY);

describe("ExportRangeOptions", () => {
  beforeEach(() => {
    localStorage.clear();
    useDawStore.setState({ project, selection: null, soloTracks: {} });
  });

  it("shows the full mix and no MP3 by default", () => {
    selectRange();
    render(<ExportRangeOptions />);
    expect(screen.getByRole("button", { name: "Full mix" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Also MP3" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("saves each change as it is made", async () => {
    selectRange();
    render(<ExportRangeOptions />);
    await userEvent.click(
      screen.getByRole("button", { name: "Selected tracks" }),
    );
    expect(stored()).toBe('{"source":"selected","includeMp3":false}');
    await userEvent.click(screen.getByRole("button", { name: "Also MP3" }));
    expect(stored()).toBe('{"source":"selected","includeMp3":true}');
    expect(
      screen.getByRole("button", { name: "Selected tracks" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("disables Soloed with its reason until a track is soloed", () => {
    selectRange();
    render(<ExportRangeOptions />);
    const soloed = screen.getByRole("button", { name: "Soloed" });
    expect(soloed).toBeDisabled();
    expect(soloed).toHaveAttribute("title", "Solo one or more tracks first.");
    expect(
      screen.getByText("Soloed: Solo one or more tracks first."),
    ).toBeVisible();
  });

  it("enables Soloed once a track is soloed", () => {
    selectRange();
    useDawStore.setState({ soloTracks: { guest: true } });
    render(<ExportRangeOptions />);
    expect(screen.getByRole("button", { name: "Soloed" })).toBeEnabled();
  });

  it("shows the full mix when the saved source has no tracks", () => {
    localStorage.setItem(
      EXPORT_RANGE_STORAGE_KEY,
      '{"source":"soloed","includeMp3":false}',
    );
    selectRange();
    render(<ExportRangeOptions />);
    expect(screen.getByRole("button", { name: "Full mix" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("exports the selected tracks and disables the full mix with a track selection", () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "host" },
    });
    render(<ExportRangeOptions />);
    const mix = screen.getByRole("button", { name: "Full mix" });
    expect(mix).toBeDisabled();
    expect(mix).toHaveAttribute(
      "title",
      "Deselect the tracks to export the full mix.",
    );
    expect(
      screen.getByRole("button", { name: "Selected tracks" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
