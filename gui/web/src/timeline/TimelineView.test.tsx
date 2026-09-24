import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { MARKER_ROW_HEIGHT, RULER_HEIGHT } from "../utils/layout";
import { TimelineView } from "./TimelineView";

describe("TimelineView follow auto-fit", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 800;
      },
    });
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("exposes the labeled loading timeline as a group", async () => {
    useDawStore.setState({ project: null });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={null}>
        <TimelineView />
      </DawProvider>,
    );

    const timeline = screen.getByRole("group", { name: "Loading timeline" });
    expect(timeline).toHaveAttribute("aria-busy", "true");
    await expectNoA11yViolations(container);
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  });

  it("does not auto-fit or unfollow when a desktop timeline mounts while following", () => {
    const fitToWindow = vi.fn();
    const stopFollow = vi.fn();
    useDawStore.setState({
      followingClientId: "leader",
      userZoomed: false,
      fitToWindow,
      stopFollow,
    });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    expect(fitToWindow).not.toHaveBeenCalled();
    expect(stopFollow).not.toHaveBeenCalled();
    expect(useDawStore.getState().followingClientId).toBe("leader");
  });

  it("sets ruler and marker-row px vars from the layout constants", () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    const area = container.querySelector(".timeline-area") as HTMLElement;
    expect(area.style.getPropertyValue("--ruler-height")).toBe(
      `${RULER_HEIGHT}px`,
    );
    expect(area.style.getPropertyValue("--marker-row-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
    // Empty project: one quiet marker row.
    expect(area.style.getPropertyValue("--marker-lane-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
  });

  it("does not unfollow when store scroll is written to the DOM", () => {
    const stopFollow = vi.fn();
    useDawStore.setState({
      followingClientId: "leader",
      stopFollow,
      scrollLeft: 0,
    });
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <TimelineView />
      </DawProvider>,
    );
    const scroller = container.querySelector(".timeline-scroll");
    expect(scroller).toBeTruthy();
    let left = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => left,
      set(v: number) {
        left = v;
        scroller?.dispatchEvent(new Event("scroll"));
      },
    });
    act(() => {
      useDawStore.getState().setScrollLeft(160);
    });
    expect(stopFollow).not.toHaveBeenCalled();
    expect(useDawStore.getState().followingClientId).toBe("leader");
  });
});
