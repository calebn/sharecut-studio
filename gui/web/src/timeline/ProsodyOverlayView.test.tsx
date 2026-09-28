import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import type { ProsodyOverlayTrack } from "../types/prosody";
import { ProsodyOverlayView } from "./ProsodyOverlayView";

function track(
  overrides: Partial<ProsodyOverlayTrack> = {},
): ProsodyOverlayTrack {
  return {
    track_id: "host",
    status: "fresh",
    segments: [
      {
        source_start: 0,
        source_end: 2,
        spans: [
          { start: 0, end: 1 },
          { start: 1, end: 2 },
        ],
        energy_thirds: [
          { db: 62, spans: [{ start: 0, end: 0.667 }] },
          { db: 60, spans: [{ start: 0.667, end: 1.333 }] },
          { db: 58, spans: [{ start: 1.333, end: 2 }] },
        ],
        trend: "falling",
        drop_db: 4,
        line: "F0 180Hz",
      },
    ],
    boundaries: [
      { timeline_sec: 2, strength: 1, kind: "segment_end", pause_sec: 0 },
    ],
    prominent_words: [
      { text: "hello", score: 1.2, word_index: 0, timeline_sec: 0.1 },
    ],
    energy_db: { min: 58, max: 62 },
    ...overrides,
  };
}

describe("ProsodyOverlayView", () => {
  it("renders segment bands, energy steps, boundary tick and prominent dot", () => {
    const { container } = render(
      <ProsodyOverlayView
        track={track()}
        zoomPxPerSec={100}
        x0={0}
        x1={1000}
      />,
    );
    expect(container.querySelectorAll(".prosody-seg")).toHaveLength(2);
    expect(container.querySelectorAll(".prosody-energy")).toHaveLength(3);
    expect(container.querySelectorAll(".prosody-boundary--end")).toHaveLength(
      1,
    );
    expect(container.querySelectorAll(".prosody-prominent")).toHaveLength(1);
    expect(
      container.querySelector(".prosody-seg[data-trend='falling']"),
    ).not.toBeNull();
  });

  it("positions left/width as sec * zoom", () => {
    const { container } = render(
      <ProsodyOverlayView
        track={track()}
        zoomPxPerSec={100}
        x0={0}
        x1={1000}
      />,
    );
    const seg = container.querySelector(".prosody-seg") as HTMLElement;
    expect(seg.style.left).toBe("0px");
    expect(seg.style.width).toBe("100px");
  });

  it("culls items outside the visible px range", () => {
    const { container } = render(
      <ProsodyOverlayView
        track={track()}
        zoomPxPerSec={100}
        x0={5000}
        x1={6000}
      />,
    );
    expect(container.querySelectorAll(".prosody-seg")).toHaveLength(0);
    expect(container.querySelectorAll(".prosody-prominent")).toHaveLength(0);
  });

  it("dims a stale track and shows its status label", () => {
    const { container, queryByRole } = render(
      <ProsodyOverlayView
        track={track({ status: "stale", hint: "x" })}
        zoomPxPerSec={100}
        x0={0}
        x1={1000}
      />,
    );
    expect(container.querySelector(".prosody-overlay--stale")).not.toBeNull();
    expect(
      container.querySelector(".lane-prosody-status")?.textContent,
    ).toMatch(/out of date/i);
    expect(queryByRole("status")).toBeNull();
  });

  it("renders only the status label for a missing profile", () => {
    const { container, queryByRole } = render(
      <ProsodyOverlayView
        track={track({
          status: "missing",
          segments: [],
          boundaries: [],
          prominent_words: [],
        })}
        zoomPxPerSec={100}
        x0={0}
        x1={1000}
      />,
    );
    expect(container.querySelector(".prosody-overlay")).toBeNull();
    expect(
      container.querySelector(".lane-prosody-status")?.textContent,
    ).toMatch(/no prosody profile/i);
    expect(queryByRole("status")).toBeNull();
  });

  it("has no a11y violations", async () => {
    const { container } = render(
      <ProsodyOverlayView
        track={track()}
        zoomPxPerSec={100}
        x0={0}
        x1={1000}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
