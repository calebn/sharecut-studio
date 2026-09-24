import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Playhead } from "./Playhead";
import { TimeRuler } from "./TimeRuler";

describe("Playhead", () => {
  it("moves with a transform, not left, so the glow composites", () => {
    const { container } = render(
      <Playhead playheadSec={2.5} zoomPxPerSec={40} height={144} />,
    );
    const el = container.querySelector(".playhead") as HTMLElement;
    expect(el.style.transform).toBe("translateX(100px)");
    expect(el.style.left).toBe("");
    expect(el.style.height).toBe("144px");
  });

  it("is the same needle in the ruler", () => {
    const { container } = render(
      <TimeRuler
        durationSec={10}
        sessionDurationSec={10}
        zoomPxPerSec={20}
        playheadSec={3}
        onSeek={vi.fn()}
      />,
    );
    const el = container.querySelector(".time-ruler .playhead") as HTMLElement;
    expect(el.style.transform).toBe("translateX(60px)");
    expect(el.style.height).toBe("100%");
  });
});
