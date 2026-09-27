import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { appliedEditRecord } from "../test/fixtures";
import { AppliedEditOverlay } from "./AppliedEditOverlay";

describe("AppliedEditOverlay", () => {
  const onSelect = vi.fn();

  it("positions track markers by timeline seconds and clamps short spans", () => {
    const { container } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({ id: "long", timeline_start: 2, timeline_end: 3 }),
          appliedEditRecord({
            id: "short",
            timeline_start: 5,
            timeline_end: 5.02,
          }),
        ]}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId="short"
        onSelect={onSelect}
      />,
    );
    const ticks = container.querySelectorAll<HTMLElement>(".applied-tick");
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toHaveStyle({ left: "40px", width: "20px" });
    expect(ticks[1]).toHaveStyle({ left: "100px", width: "3px" });
    expect(ticks[1]).toHaveClass("selected");
  });

  it("filters other tracks and unmapped records", () => {
    const { container } = render(
      <AppliedEditOverlay
        records={[
          appliedEditRecord({ id: "visible" }),
          appliedEditRecord({ id: "other", track_ids: ["ari-voice"] }),
          appliedEditRecord({ id: "no-start", timeline_start: null }),
          appliedEditRecord({ id: "no-end", timeline_end: null }),
        ]}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    expect(container.querySelectorAll(".applied-tick")).toHaveLength(1);
    expect(container.querySelector(".applied-tick")).toHaveAttribute(
      "title",
      "remove: Shorten the pause",
    );
  });

  it("keeps ticks decorative and does not select on click", () => {
    onSelect.mockClear();
    const { container, queryByRole } = render(
      <AppliedEditOverlay
        records={[appliedEditRecord()]}
        trackId="mira-voice"
        zoomPxPerSec={20}
        selectedId={null}
        onSelect={onSelect}
      />,
    );
    const tick = container.querySelector<HTMLElement>(".applied-tick");
    expect(tick).toHaveAttribute("aria-hidden", "true");
    expect(tick).not.toHaveAttribute("tabindex");
    expect(queryByRole("button")).toBeNull();
    fireEvent.click(tick!);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
