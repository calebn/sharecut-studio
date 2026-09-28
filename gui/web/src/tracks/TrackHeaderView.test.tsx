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
    expect(screen.getByTitle("Stale: fx")).toHaveTextContent("FX");
    expect(
      screen.getByRole("button", { name: "Reorder track Mira" }),
    ).toHaveAttribute("draggable", "true");
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
    expect(container.querySelector(".stem-dot")).toBeNull();
  });
});
