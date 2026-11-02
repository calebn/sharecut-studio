import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import { SeamMarks } from "./SeamMarks";

const clips = [
  clipRow({
    id: "c1",
    source_start: 0,
    source_end: 2,
    timeline_start: 0,
    timeline_end: 2,
  }),
  clipRow({
    id: "c2",
    source_start: 3,
    source_end: 5,
    timeline_start: 2,
    timeline_end: 4,
  }),
];

const ripple = appliedEditRecord({
  id: "ripple",
  operation: "ripple_delete",
  timeline_start: 40,
  timeline_end: 50,
  source_start: null,
  source_end: null,
  params: { per_track_source: { "mira-voice": [2, 3] } },
});

function setup(props: Partial<React.ComponentProps<typeof SeamMarks>> = {}): {
  onSelect: ReturnType<typeof vi.fn>;
  onZoomChip: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onZoomChip = vi.fn();
  render(
    <SeamMarks
      records={[ripple]}
      clips={clips}
      trackId="mira-voice"
      zoomPxPerSec={20}
      sessionSec={60}
      selectedId={null}
      onSelect={onSelect}
      onZoomChip={onZoomChip}
      {...props}
    />,
  );
  return { onSelect, onZoomChip };
}

describe("SeamMarks", () => {
  it("draws a cut as a Seam button at its projected second and selects its record", () => {
    const { onSelect } = setup();
    const button = screen.getByRole("button", { name: /^Cut at/ });
    expect(button.closest(".applied-seam")).toHaveStyle({ left: "40px" });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("ripple");
  });

  it("marks the selected record pressed", () => {
    setup({ selectedId: "ripple" });
    expect(screen.getByRole("button", { name: /^Cut at/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps a mute tick decorative, apart from a cut's seam", () => {
    setup({
      records: [
        appliedEditRecord({
          id: "mute",
          operation: "approve_edits",
          source_start: 0.5,
          source_end: 1,
          params: { mute: true },
        }),
        ripple,
      ],
    });
    expect(document.querySelectorAll(".applied-tick--mute")).toHaveLength(2);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("folds seams closer than 24 px into a count chip that zooms to the group", () => {
    const records = [0, 1, 2].map((i) =>
      appliedEditRecord({
        id: `r${i}`,
        operation: "ripple_delete",
        source_start: null,
        source_end: null,
        params: { per_track_source: { "mira-voice": [i + 1, i + 1] } },
      }),
    );
    const denseClips = [0, 1, 2, 3].map((i) =>
      clipRow({
        id: `d${i}`,
        source_start: i,
        source_end: i + 1,
        timeline_start: i,
        timeline_end: i + 1,
      }),
    );
    const { onZoomChip } = setup({
      records,
      clips: denseClips,
      zoomPxPerSec: 10,
    });
    expect(document.querySelectorAll(".applied-seam")).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: /3 cuts close together/ }),
    );
    expect(onZoomChip).toHaveBeenCalledTimes(1);
    expect(onZoomChip.mock.calls[0][0].zoomTo).toBeGreaterThan(10);
  });

  it("filters other tracks and unmapped records, and renders no layer when empty", () => {
    setup({
      records: [
        appliedEditRecord({ id: "other", track_ids: ["ari-voice"] }),
        appliedEditRecord({
          id: "no-source",
          operation: "ripple_delete",
          source_start: null,
          source_end: null,
          params: {},
        }),
      ],
    });
    expect(document.querySelector(".applied-edit-layer")).toBeNull();
  });

  it("has no axe violations with a selected seam", async () => {
    setup({ selectedId: "ripple" });
    await expectNoA11yViolations(document.body);
  });
});
