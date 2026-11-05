import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { stubRaf } from "../test/raf";
import { LiveSimulation } from "./LevelMeter.stories";
import {
  createParticipantMeterSource,
  createScriptedMeterSource,
} from "./meterStorySource";
import { RecordRoster } from "./ParticipantMeter.stories";

function peakDb(frame: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < frame.length; i++)
    peak = Math.max(peak, Math.abs(frame[i]));
  return 20 * Math.log10(peak);
}

let clock: MockInstance<() => number>;
let noise: MockInstance<() => number>;
beforeEach(() => {
  clock = vi.spyOn(performance, "now").mockReturnValue(0);
  noise = vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("synthetic meter source ownership", () => {
  it("does not sample time or noise during construction", () => {
    const scripted = createScriptedMeterSource();
    const participant = createParticipantMeterSource(1, 12);
    expect(clock).not.toHaveBeenCalled();
    expect(noise).not.toHaveBeenCalled();
    expect(scripted.read()).toHaveLength(0);
    expect(participant.read()).toHaveLength(0);
    expect(clock).not.toHaveBeenCalled();
  });

  it("starts the scripted take at attachment and includes a delayed first frame", () => {
    const source = createScriptedMeterSource();
    clock.mockReturnValue(1000);
    source.attach();
    clock.mockReturnValue(6000);
    expect(peakDb(source.read())).toBeGreaterThan(-24);
    expect(peakDb(source.read())).toBeLessThan(-8);
  });

  it.each([0, 1999, 16000, 17999])(
    "retains scripted room tone at %i ms",
    (now) => {
      const source = createScriptedMeterSource();
      source.attach();
      clock.mockReturnValue(now);
      expect(peakDb(source.read())).toBeCloseTo(-48, 4);
    },
  );

  it.each([8000, 8499, 24000])(
    "retains the scripted hot interval at %i ms",
    (now) => {
      const source = createScriptedMeterSource();
      source.attach();
      noise.mockReturnValue(0.9);
      clock.mockReturnValue(now);
      expect(peakDb(source.read())).toBeGreaterThan(0);
    },
  );

  it.each([2000, 7999, 8500, 15999])(
    "retains scripted speech at %i ms",
    (now) => {
      const source = createScriptedMeterSource();
      source.attach();
      clock.mockReturnValue(now);
      expect(peakDb(source.read())).toBeGreaterThan(-21);
      expect(peakDb(source.read())).toBeLessThan(-11);
    },
  );

  it("reuses each owned buffer with its original waveform and one noise draw per frame", () => {
    const scripted = createScriptedMeterSource();
    scripted.attach();
    const first = scripted.read();
    expect(first).toBeInstanceOf(Float32Array);
    expect(first).toHaveLength(2048);
    expect(first[0]).toBe(0);
    expect(first[128]).toBeGreaterThan(0);
    expect(first[384]).toBeCloseTo(-first[128], 8);
    expect(first[512]).toBeCloseTo(0, 8);
    expect(scripted.read()).toBe(first);
    expect(noise).toHaveBeenCalledTimes(2);
    const participant = createParticipantMeterSource(1, null);
    participant.attach();
    const second = participant.read();
    expect(second).toHaveLength(1024);
    expect(second).not.toBe(first);
    expect(second[256]).toBeLessThan(0);
    expect(second[768]).toBeCloseTo(-second[256], 8);
    expect(second[512]).toBeCloseTo(0, 8);
    expect(participant.read()).toBe(second);
    expect(noise).toHaveBeenCalledTimes(4);
  });

  it("keeps the participant's absolute clock and strict hot-window boundaries", () => {
    clock.mockReturnValue(12200);
    const source = createParticipantMeterSource(4, 12);
    source.attach();
    expect(peakDb(source.read())).toBeCloseTo(-0.3, 4);
    clock.mockReturnValue(12000);
    expect(peakDb(source.read())).toBeLessThan(-12);
    clock.mockReturnValue(12400);
    expect(peakDb(source.read())).toBeLessThan(-12);
    clock.mockReturnValue(32200);
    expect(peakDb(source.read())).toBeCloseTo(-0.3, 4);
    const replacement = createParticipantMeterSource(9, 12);
    replacement.attach();
    expect(peakDb(replacement.read())).toBeCloseTo(-0.3, 4);
  });

  it("releases its buffer on disposal and starts a new scripted attachment", () => {
    const source = createScriptedMeterSource();
    source.attach();
    const old = source.read();
    source.dispose();
    expect(source.read()).toHaveLength(0);
    clock.mockReturnValue(8000);
    source.attach();
    expect(source.read()).not.toBe(old);
    expect(peakDb(source.read())).toBeCloseTo(-48, 4);
  });
});

describe("actual meter stories", () => {
  it("keeps its reader across rerenders and preserves clip latch and Clear", () => {
    const raf = stubRaf();
    const view = render(<StrictMode>{LiveSimulation.render()}</StrictMode>);
    expect(raf.pendingCount()).toBe(1);
    const cancelled = raf.cancel.mock.calls.length;
    act(() => raf.fire(0));
    view.rerender(<StrictMode>{LiveSimulation.render()}</StrictMode>);
    expect(raf.cancel).toHaveBeenCalledTimes(cancelled);
    clock.mockReturnValue(8100);
    noise.mockReturnValue(0.9);
    act(() => raf.fire(8100));
    const clear = screen.getByRole("button", { name: "Clear clip indicator" });
    expect(clear).toBeEnabled();
    clock.mockReturnValue(9000);
    act(() => raf.fire(9000));
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(clear).toBeDisabled();
    view.unmount();
    expect(raf.pendingCount()).toBe(0);
  });

  it("shares the existing meter loop across both story families and disposes the last subscriber", () => {
    const raf = stubRaf();
    const scripted = render(LiveSimulation.render());
    const roster = render(RecordRoster.render());
    expect(screen.getAllByRole("meter")).toHaveLength(5);
    expect(raf.pendingCount()).toBe(1);
    act(() => raf.fire(0));
    scripted.unmount();
    expect(raf.pendingCount()).toBe(1);
    roster.unmount();
    expect(raf.pendingCount()).toBe(0);
  });
});
