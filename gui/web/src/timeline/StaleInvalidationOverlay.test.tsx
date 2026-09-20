import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StaleInvalidationOverlay } from "./StaleInvalidationOverlay";

describe("StaleInvalidationOverlay", () => {
  it("renders regional bands only", () => {
    const { container } = render(
      <StaleInvalidationOverlay
        trackId="host"
        zoomPxPerSec={10}
        width={1000}
        invalidations={[
          {
            id: "a",
            track_ids: ["host"],
            timeline_start: 2,
            timeline_end: 5,
            reason: "cut",
            at: "t",
          },
          {
            id: "b",
            track_ids: ["host"],
            timeline_start: null,
            timeline_end: null,
            reason: "fx",
            at: "t",
          },
          {
            id: "c",
            track_ids: ["guest"],
            timeline_start: 1,
            timeline_end: 2,
            reason: "cut",
            at: "t",
          },
        ]}
      />,
    );
    const bands = container.querySelectorAll(".stale-inv-band");
    expect(bands).toHaveLength(1);
    expect((bands[0] as HTMLElement).style.left).toBe("20px");
    expect((bands[0] as HTMLElement).style.width).toBe("30px");
  });
});
