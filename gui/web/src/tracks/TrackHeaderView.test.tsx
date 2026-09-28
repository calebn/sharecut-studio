import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleTrack } from "../test/fixtures";
import { TrackHeaderView } from "./TrackHeaderView";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";

const track = sampleTrack({ id: "mira", label: "Mira", fx_count: 2 });
const mixer = (
  <TrackMuteSoloButtonsView
    trackId="mira"
    trackLabel="Mira"
    muteState="off"
    solo={false}
    editsMix
    onMute={() => undefined}
    onSolo={() => undefined}
  />
);

function renderHeader(
  overrides: Partial<Parameters<typeof TrackHeaderView>[0]> = {},
) {
  const onSelect = vi.fn();
  const result = render(
    <TrackHeaderView
      track={track}
      trackIndex={0}
      selected={false}
      muted={false}
      stemClass="fresh"
      wholeReasons={[]}
      hasRegional={false}
      headerHighlight={false}
      dropHighlight={false}
      dragging={false}
      dropEdge={null}
      mayReorder={false}
      mixer={mixer}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { ...result, onSelect };
}

describe("TrackHeaderView", () => {
  it("renders accessible production track details from props", async () => {
    const { container, onSelect } = renderHeader();
    const open = screen.getByRole("button", {
      name: "Open track details, Mira",
    });
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTitle("2 effects")).toHaveTextContent("FX 2");
    expect(screen.getByRole("img", { name: "Stem up to date" })).toBeTruthy();
    const out = screen.getByText("Out 0.0 dB");
    expect(out).toHaveAttribute("title");
    // layout.css keys the compact grid area and narrow-pane hide rule on it.
    expect(out).toHaveClass("track-out-gain");
    expect(container.querySelector(".gain-strip")).toBeNull();
    expect(screen.getByText("dialogue")).toBeTruthy();
    await userEvent.click(open);
    expect(onSelect).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("shows selection, stale reason and reorder edge while preserving an empty lane", () => {
    const { container, rerender } = renderHeader({
      selected: true,
      stemClass: "stale",
      wholeReasons: ["fx"],
      headerHighlight: true,
      mayReorder: true,
      dropEdge: "after",
    });
    expect(
      screen.getByRole("button", { name: "Open track details, Mira" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".track-header-row")).toHaveClass(
      "stale-whole-track",
      "drop-after",
      "reorderable",
    );
    expect(screen.getByRole("img", { name: "Stem out of date" })).toBeTruthy();
    expect(screen.getByTitle("Stem out of date: FX")).toHaveTextContent("FX");
    const grip = screen.getByRole("button", { name: "Reorder track Mira" });
    expect(grip).toHaveAttribute("draggable", "true");
    expect(grip).not.toHaveAttribute("tabindex");
    expect(grip).toHaveAttribute("title");
    rerender(
      <TrackHeaderView
        track={sampleTrack({
          id: "empty",
          label: "Empty",
          duration_sec: 0,
          stem_is_fresh: false,
        })}
        trackIndex={1}
        selected={false}
        muted={false}
        stemClass=""
        wholeReasons={[]}
        hasRegional={false}
        headerHighlight={false}
        dropHighlight={false}
        dragging={false}
        dropEdge={null}
        mayReorder={false}
        mixer={mixer}
        onSelect={() => undefined}
      />,
    );
    expect(container.querySelector(".stem-status")).toBeNull();
  });

  it("selects the track when the reorder grip is clicked or Enter is pressed, not the open button", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onHandleSelect = vi.fn();
    renderHeader({ mayReorder: true, onSelect, onHandleSelect });
    const grip = screen.getByRole("button", { name: "Reorder track Mira" });
    await user.click(grip);
    expect(onHandleSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    grip.focus();
    await user.keyboard("{Enter}");
    expect(onHandleSelect).toHaveBeenCalledTimes(2);
  });

  it("drops a speaker that repeats the track name", () => {
    renderHeader({
      track: sampleTrack({ id: "mira", label: "Mira", speaker: "Mira" }),
    });
    expect(screen.getByText("dialogue")).toBeTruthy();
    expect(screen.queryByText("dialogue · Mira")).toBeNull();
  });

  it("spells out envelope and other stale reason chips", () => {
    renderHeader({
      stemClass: "stale",
      wholeReasons: ["envelope", "other"],
      headerHighlight: true,
    });
    expect(screen.getByText("Envelope")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("labels a regional-only stale track with full words", () => {
    renderHeader({
      stemClass: "stale",
      hasRegional: true,
      headerHighlight: true,
    });
    expect(screen.getByText("Some regions")).toHaveAttribute(
      "title",
      "Parts of this track are out of date",
    );
  });
});
