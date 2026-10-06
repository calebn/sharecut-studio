import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import {
  registerDawCommands,
  setBladeCommandRunner,
} from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { TransportBar } from "./TransportBar";

// Delegates to the real hook, so behavior is unchanged, while letting the
// test count how many times TransportBar itself calls it (once per render).
const breakdownCalls = vi.hoisted(() => vi.fn());
vi.mock("../hooks/useStaleRenderBreakdown", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../hooks/useStaleRenderBreakdown")>();
  return {
    ...mod,
    useStaleRenderBreakdown: (
      ...args: Parameters<typeof mod.useStaleRenderBreakdown>
    ) => {
      breakdownCalls();
      return mod.useStaleRenderBreakdown(...args);
    },
  };
});

describe("TransportBar renders", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ timeline_duration_sec: 100 }));
    clearRegisteredCommands();
    registerDawCommands();
  });

  afterEach(() => {
    setBladeCommandRunner(null);
  });

  it("leads the end zone with Solo on · Clear solo while any track is soloed", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ timeline_duration_sec: 100 })}
      >
        <TransportBar />
      </DawProvider>,
    );
    expect(container.querySelector(".solo-chip")).toBeNull();
    act(() => useDawStore.getState().setSoloMap({ host: true }));
    const chip = screen.getByRole("button", { name: "Solo on · Clear solo" });
    expect(
      container.querySelector(".transport-zone--end")?.firstElementChild,
    ).toBe(chip);
    expect(chip).toHaveAttribute(
      "title",
      "Other tracks are silent for you only. Clear solo plays every track again",
    );
    await expectNoA11yViolations(container);

    rerender(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ timeline_duration_sec: 100 })}
      >
        <TransportBar showStatusChips={false} />
      </DawProvider>,
    );
    expect(container.querySelector(".solo-chip")).toBeNull();
    rerender(
      <DawProvider
        projectPath="/tmp/p.json"
        initialProject={minimalProject({ timeline_duration_sec: 100 })}
      >
        <TransportBar />
      </DawProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "Solo on · Clear solo" }),
    );
    expect(useDawStore.getState().soloTracks).toEqual({});
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Solo off. Every track plays again.",
    );
    expect(container.querySelector(".solo-chip")).toBeNull();
  });

  it("does not re-render on playhead ticks; the timecode leaf still updates", () => {
    const onRender = vi.fn();
    render(
      <Profiler id="transport" onRender={onRender}>
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject({ timeline_duration_sec: 100 })}
        >
          <TransportBar />
        </DawProvider>
      </Profiler>,
    );
    onRender.mockClear();
    breakdownCalls.mockClear();

    for (let i = 1; i <= 10; i++) {
      act(() => {
        useDawStore.setState({ playheadSec: i });
      });
    }

    // The Profiler wraps TransportTimecode too, so it still reports the
    // leaf's own commits; useStaleRenderBreakdown is the reliable signal
    // that TransportBar's own function body did not re-run.
    expect(breakdownCalls).not.toHaveBeenCalled();
    expect(document.querySelector(".timecode-current")?.textContent).toBe(
      "00:10.000",
    );
  });

  it("cuts at the current playhead when the blade button is clicked", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 1400,
    });
    try {
      const requestCut = vi.fn();
      setBladeCommandRunner({
        requestCut,
        confirmPending: vi.fn(),
        cancelPending: vi.fn(),
      });
      render(
        <DawProvider
          projectPath="/tmp/p.json"
          initialProject={minimalProject({ tracks: [] })}
        >
          <TransportBar />
        </DawProvider>,
      );
      act(() => {
        useDawStore.setState({ toolMode: "blade", playheadSec: 12 });
      });
      await userEvent.click(
        screen.getByRole("button", { name: "Cut at playhead" }),
      );
      expect(requestCut).toHaveBeenCalledWith(12);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });
});
