import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { useShortFrame } from "./useShortFrame";

/**
 * The fold is a measured fit. jsdom lays nothing out and the test setup's
 * ResizeObserver never fires, so a re-measure that happens here is one the
 * hook asked for itself.
 */

const FRAME = 380;

function Frame() {
  const ref = useRef<HTMLDivElement>(null);
  const folded = useShortFrame(ref);
  const stage = useDawStore((s) => s.stage);
  return (
    <div ref={ref} data-folded={folded ? "yes" : "no"}>
      <div className="stage-frame-header" />
      <div className="stage-frame-player" />
      {stage === "edit" ? <div className="phone-edit-bar" /> : null}
    </div>
  );
}

/** An Edit frame whose rows exist only on one surface, so the fit changes with no stage switch. */
function EditFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const folded = useShortFrame(ref);
  const surface = useDawStore((s) => s.editSurface);
  return (
    <div ref={ref} data-folded={folded ? "yes" : "no"}>
      <div className="stage-frame-header" />
      <div className="stage-frame-player" />
      {surface === "text" ? <div className="phone-edit-bar" /> : null}
    </div>
  );
}

function sizeOf(el: Element): number {
  if (el.classList.contains("stage-frame-header")) return 60;
  if (el.classList.contains("stage-frame-player")) return 80;
  if (el.classList.contains("phone-edit-bar")) return 60;
  if (el.hasAttribute("data-folded")) return FRAME;
  const style = (el as HTMLElement).style.blockSize;
  if (style.includes("--stage-stacked-lanes-min")) return 200;
  if (style.includes("--lane-height")) return 84;
  return 0;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return { height: sizeOf(this) } as DOMRect;
    },
  );
  useDawStore.setState({ stage: "review", editSurface: "lanes" });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.frameShort;
});

describe("useShortFrame", () => {
  it("re-measures the fold on a stage switch, with no resize to report it", () => {
    const { container } = render(<Frame />);
    const frame = () => container.firstElementChild as HTMLElement;
    // Review: 60 + 80 + 200 fits 380.
    expect(frame().dataset.folded).toBe("no");
    expect("frameShort" in document.documentElement.dataset).toBe(false);

    // Edit adds the 60 px rows: 400 does not.
    act(() => useDawStore.getState().openStage("edit"));
    expect(frame().dataset.folded).toBe("yes");
    expect("frameShort" in document.documentElement.dataset).toBe(true);

    act(() => useDawStore.getState().openStage("review"));
    expect(frame().dataset.folded).toBe("no");
    expect("frameShort" in document.documentElement.dataset).toBe(false);
  });

  it("measures once at mount", () => {
    useDawStore.setState({ stage: "edit" });
    const { container } = render(<Frame />);
    expect((container.firstElementChild as HTMLElement).dataset.folded).toBe(
      "yes",
    );
  });

  it("re-measures the fold when the Edit surface changes on the same stage", () => {
    useDawStore.setState({ stage: "edit", editSurface: "lanes" });
    const { container } = render(<EditFrame />);
    const frame = () => container.firstElementChild as HTMLElement;
    // Lanes: 60 + 80 + 200 fits 380.
    expect(frame().dataset.folded).toBe("no");

    // The text surface adds the 60 px rows: 400 does not.
    act(() => useDawStore.getState().setEditSurface("text"));
    expect(frame().dataset.folded).toBe("yes");

    act(() => useDawStore.getState().setEditSurface("lanes"));
    expect(frame().dataset.folded).toBe("no");
  });
});
