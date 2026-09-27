import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { renderInvalidation } from "../test/fixtures";
import { StaleInvalidationOverlay } from "./StaleInvalidationOverlay";

describe("StaleInvalidationOverlay", () => {
  const defaultProps = {
    trackId: "mira-voice",
    zoomPxPerSec: 10,
    width: 100,
  };

  it("renders regional bands only", () => {
    const { container } = render(
      <StaleInvalidationOverlay
        {...defaultProps}
        invalidations={[
          renderInvalidation(),
          renderInvalidation({
            id: "whole",
            timeline_start: null,
            timeline_end: null,
          }),
          renderInvalidation({ id: "foreign", track_ids: ["ari-voice"] }),
        ]}
      />,
    );
    const bands = container.querySelectorAll<HTMLElement>(".stale-inv-band");
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveStyle({ left: "20px", width: "30px" });
    expect(bands[0]).toHaveAttribute("title", "cut · 2.0–5.0s");
  });

  it("keeps short spans visible and clips bands at the right edge", () => {
    const { container } = render(
      <StaleInvalidationOverlay
        {...defaultProps}
        invalidations={[
          renderInvalidation({
            id: "short",
            timeline_start: 1,
            timeline_end: 1.01,
          }),
          renderInvalidation({
            id: "edge",
            timeline_start: 9.5,
            timeline_end: 12,
          }),
        ]}
      />,
    );
    const bands = container.querySelectorAll<HTMLElement>(".stale-inv-band");
    expect(bands).toHaveLength(2);
    expect(bands[0]).toHaveStyle({ left: "10px", width: "3px" });
    expect(bands[1]).toHaveStyle({ left: "95px", width: "5px" });
  });

  it("renders no overlay for a track without regional invalidation", () => {
    const { container } = render(
      <StaleInvalidationOverlay
        {...defaultProps}
        invalidations={[renderInvalidation({ track_ids: ["ari-voice"] })]}
      />,
    );
    expect(container.querySelector(".stale-inv-overlay")).toBeNull();
  });

  it("keeps decorative bands out of the accessibility tree", async () => {
    const { container, queryByRole } = render(
      <main>
        <StaleInvalidationOverlay
          {...defaultProps}
          invalidations={[renderInvalidation()]}
        />
      </main>,
    );
    expect(container.querySelector(".stale-inv-overlay")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(queryByRole("button")).toBeNull();
    await expectNoA11yViolations(container);
  });
});
