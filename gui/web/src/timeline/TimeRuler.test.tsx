import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeRuler } from "./TimeRuler";

describe("TimeRuler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the colliding end label on a narrow touch timeline", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
    }));
    const { container } = render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        playheadSec={0}
        onSeek={vi.fn()}
      />,
    );
    const labels = [...container.querySelectorAll(".ruler-tick")].map(
      (el) => el.textContent,
    );
    // 0:08 would collide with 0:06, so it is skipped.
    expect(labels).not.toContain("0:08");
    expect(labels).toContain("0:06");
  });

  it("keeps the end label on desktop where labels fit", () => {
    // No matchMedia stub: fine pointer, tight estimate, no drop.
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        playheadSec={0}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("0:08")).toBeTruthy();
  });

  it("keeps the end label when there is room", () => {
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={200}
        playheadSec={0}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("0:08")).toBeTruthy();
  });
});
