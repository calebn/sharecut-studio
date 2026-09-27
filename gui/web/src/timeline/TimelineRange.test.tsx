import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import { AuditionOverlay } from "./AuditionOverlay";
import { CommentSelectionOverlay } from "./CommentSelectionOverlay";

describe("timeline range overlays", () => {
  it("positions an audition range and keeps a short range visible", async () => {
    const { container } = render(
      <main>
        <AuditionOverlay
          startSec={2}
          endSec={10}
          zoomPxPerSec={20}
          height={120}
          label="Preview range"
        />
        <AuditionOverlay
          startSec={2}
          endSec={2}
          zoomPxPerSec={20}
          height={120}
        />
      </main>,
    );
    const [range, point] =
      container.querySelectorAll<HTMLElement>(".audition-overlay");
    expect(range.style.left).toBe("40px");
    expect(range.style.width).toBe("160px");
    expect(range.textContent).toBe("Preview range");
    expect(point.style.width).toBe("3px");
    await expectNoA11yViolations(container);
  });

  it("positions a comment span and centers a point pin", async () => {
    const { container } = render(
      <main>
        <CommentSelectionOverlay
          comment={sampleComment({
            timeline_start: 4,
            timeline_end: 9,
          })}
          zoomPxPerSec={20}
          height={120}
        />
        <CommentSelectionOverlay
          comment={sampleComment({ timeline_start: 5 })}
          zoomPxPerSec={20}
          height={120}
        />
      </main>,
    );
    const span = container.querySelector<HTMLElement>(
      ".comment-selection-overlay.span",
    );
    const pin = container.querySelector<HTMLElement>(
      ".comment-selection-overlay.pin",
    );
    expect(span?.style.left).toBe("80px");
    expect(span?.style.width).toBe("100px");
    expect(pin?.style.left).toBe("98px");
    expect(pin?.style.width).toBe("4px");
    await expectNoA11yViolations(container);
  });
});
