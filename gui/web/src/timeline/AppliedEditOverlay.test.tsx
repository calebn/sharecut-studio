import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import { AppliedEditOverlay } from "./AppliedEditOverlay";

describe("AppliedEditOverlay", () => {
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
      />,
    );
    expect(container.querySelector(".applied-edit-layer")).toBeNull();
    expect(container.querySelectorAll(".applied-tick")).toHaveLength(0);
  });

  it("carries no hover title, since the layer never receives pointer events", () => {
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
      />,
    );
    const tick = container.querySelector(".applied-tick");
    expect(tick).not.toBeNull();
    expect(tick).not.toHaveAttribute("title");
  });

  it("keeps ticks decorative: no focus stop and no button role", () => {
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
      />,
    );
    const tick = container.querySelector<HTMLElement>(".applied-tick");
    expect(tick).not.toHaveAttribute("tabindex");
    expect(queryByRole("button")).toBeNull();
  });

  it("has no axe violations with a selected seam tick", async () => {
    const { container } = render(
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
        selectedId="ripple"
      />,
    );
    expect(container.querySelector(".applied-tick")).not.toBeNull();
    await expectNoA11yViolations(container);
  });
});
