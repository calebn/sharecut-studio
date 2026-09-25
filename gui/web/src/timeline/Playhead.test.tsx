import { act, render } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { Playhead } from "./Playhead";
import { TimeRuler } from "./TimeRuler";

describe("Playhead", () => {
  beforeEach(() => {
    useDawStore.setState({ playheadSec: 2.5, zoomPxPerSec: 40 });
  });

  it("moves with a transform, not left, so the glow composites", () => {
    const { container } = render(<Playhead height={144} />);
    const el = container.querySelector(".playhead") as HTMLElement;
    expect(el.style.transform).toBe("translateX(100px)");
    expect(el.style.left).toBe("");
    expect(el.style.height).toBe("144px");
  });

  it("follows the store playhead and zoom without re-rendering", () => {
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="playhead" onRender={onRender}>
        <Playhead height={144} />
      </Profiler>,
    );
    const el = container.querySelector(".playhead") as HTMLElement;
    onRender.mockClear();
    act(() => useDawStore.setState({ playheadSec: 5 }));
    expect(el.style.transform).toBe("translateX(200px)");
    act(() => useDawStore.setState({ zoomPxPerSec: 10 }));
    expect(el.style.transform).toBe("translateX(50px)");
    expect(onRender).not.toHaveBeenCalled();
  });

  it("is the same needle in the ruler", () => {
    useDawStore.setState({ playheadSec: 3, zoomPxPerSec: 20 });
    const { container } = render(
      <TimeRuler
        durationSec={10}
        sessionDurationSec={10}
        zoomPxPerSec={20}
        onSeek={vi.fn()}
      />,
    );
    const el = container.querySelector(".time-ruler .playhead") as HTMLElement;
    expect(el.style.transform).toBe("translateX(60px)");
    expect(el.style.height).toBe("100%");
  });
});
