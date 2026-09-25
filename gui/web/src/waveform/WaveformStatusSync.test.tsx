import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";

const mocks = vi.hoisted(() => ({
  refreshWaveformStatus: vi.fn(),
  retainWaveformStatus: vi.fn(),
  retainPyramids: vi.fn(),
  retainPcm: vi.fn(),
  startRasterWorker: vi.fn(),
  installHook: vi.fn(),
}));

vi.mock("./statusStore", () => ({
  refreshWaveformStatus: mocks.refreshWaveformStatus,
  retainWaveformStatus: mocks.retainWaveformStatus,
}));
vi.mock("./pyramidStore", () => ({ retainPyramids: mocks.retainPyramids }));
vi.mock("./pcmStore", () => ({ retainPcm: mocks.retainPcm }));
vi.mock("./rasterClient", () => ({
  startRasterWorker: mocks.startRasterWorker,
}));
vi.mock("./e2eHook", () => ({ installWaveformE2eHook: mocks.installHook }));

const { WaveformStatusSync } = await import("./WaveformStatusSync");

describe("WaveformStatusSync", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockClear();
    }
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", minimalProject({ tracks: [sampleTrack()] }));
  });

  it("refreshes status when the media signature changes, not on other edits", () => {
    render(<WaveformStatusSync />);
    expect(mocks.refreshWaveformStatus).not.toHaveBeenCalled();
    const p = useDawStore.getState().project!;
    act(() => useDawStore.getState().setProject({ ...p, chapters: [] }));
    expect(mocks.refreshWaveformStatus).not.toHaveBeenCalled();
    act(() =>
      useDawStore.getState().setProject({
        ...p,
        tracks: [{ ...p.tracks[0]!, stem_is_fresh: false }],
      }),
    );
    expect(mocks.refreshWaveformStatus).toHaveBeenCalledWith("/tmp/p.json");
  });

  it("starts the raster worker and the E2E hook once", () => {
    const view = render(<WaveformStatusSync />);
    view.rerender(<WaveformStatusSync />);
    expect(mocks.startRasterWorker).toHaveBeenCalledOnce();
    expect(mocks.installHook).toHaveBeenCalledOnce();
  });

  it("drops other projects' waveform work", () => {
    render(<WaveformStatusSync />);
    for (const fn of [
      mocks.retainWaveformStatus,
      mocks.retainPyramids,
      mocks.retainPcm,
    ]) {
      expect(fn).toHaveBeenCalledWith("/tmp/p.json");
    }
  });
});
