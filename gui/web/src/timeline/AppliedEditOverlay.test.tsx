import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import { AppliedEditOverlay } from "./AppliedEditOverlay";

describe("AppliedEditOverlay", () => {
  const onSelect = vi.fn();
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

  it("positions seam ticks by the projected timeline second, no inline width", () => {
    const { container } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({
            id: "ripple",
            operation: "ripple_delete",
            timeline_start: 40,
            timeline_end: 50,
            source_start: null,
            source_end: null,
            params: { per_track_source: { "mira-voice": [2, 3] } },
          }),
        ]}
        clips={clips}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId="ripple"
        onSelect={onSelect}
      />,
    );
    const layer = container.querySelector(".applied-edit-layer");
    expect(layer).not.toBeNull();
    expect(layer).toHaveAttribute("aria-hidden", "true");
    const tick = container.querySelector<HTMLElement>(".applied-tick--seam");
    expect(tick).not.toBeNull();
    expect(tick).toHaveStyle({ left: "40px" });
    expect(tick?.style.width).toBe("");
    expect(tick).toHaveClass("selected");
  });

  it("filters other tracks and unmapped records, and renders no layer when empty", () => {
    const { container } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({ id: "other", track_ids: ["ari-voice"] }),
          appliedEditRecord({
            id: "no-source",
            operation: "ripple_delete",
            source_start: null,
            source_end: null,
            params: {},
          }),
        ]}
        clips={clips}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelector(".applied-edit-layer")).toBeNull();
    expect(container.querySelectorAll(".applied-tick")).toHaveLength(0);
  });

  it("uses a humanized title when the reason is empty (no more 'op: ')", () => {
    const { container } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({
            id: "ripple",
            operation: "ripple_delete",
            reason: null,
            source_start: null,
            source_end: null,
            params: { per_track_source: { "mira-voice": [2, 3] } },
          }),
        ]}
        clips={clips}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    const tick = container.querySelector(".applied-tick");
    expect(tick).toHaveAttribute("title", "Ripple delete");
  });

  it("keeps ticks decorative and does not select on click", () => {
    onSelect.mockClear();
    const { container, queryByRole } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({
            id: "ripple",
            operation: "ripple_delete",
            source_start: null,
            source_end: null,
            params: { per_track_source: { "mira-voice": [2, 3] } },
          }),
        ]}
        clips={clips}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    const tick = container.querySelector<HTMLElement>(".applied-tick");
    expect(tick).not.toHaveAttribute("tabindex");
    expect(queryByRole("button")).toBeNull();
    fireEvent.click(tick!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
