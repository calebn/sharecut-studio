import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, setEnvelope: vi.fn(async () => undefined) };
});

describe("envelope.addPoint", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.setEnvelope).mockReset().mockResolvedValue(null);
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        timeline_duration_sec: 10,
        envelopes: [],
      }),
    );
    useDawStore.getState().setLayerVisible("showLevels", false);
  });

  it("saves a flat first-point shape through the registered command and selects the submitted ID", async () => {
    useDawStore.getState().setLayerVisible("showLevels", true);
    const result = await execute(
      "envelope.addPoint",
      { trackId: "host", atTime: 4 },
      { skipWhen: true },
    );

    expect(result).toEqual({ status: "ok" });
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    const [path, trackId, points, origin] = vi.mocked(api.setEnvelope).mock
      .calls[0]!;
    expect(path).toBe("/tmp/p.json");
    expect(trackId).toBe("host");
    expect(origin).toEqual([]);
    expect(points).toHaveLength(3);
    expect(points.map(({ time, value }) => ({ time, value }))).toEqual([
      { time: 0, value: 1 },
      { time: 4, value: 1 },
      { time: 10, value: 1 },
    ]);
    expect(new Set(points.map(({ id }) => id)).size).toBe(3);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: points[1]!.id,
    });
    expect(useDawStore.getState().layers.showLevels).toBe(true);
  });

  it("refuses to create a point while the volume envelope is hidden", async () => {
    const result = await execute(
      "envelope.addPoint",
      { trackId: "host", atTime: 4 },
      { skipWhen: true },
    );

    expect(result).toEqual({
      status: "disabled",
      reason: "Show the volume envelope before adding a point",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
    expect(useDawStore.getState().project?.envelopes).toEqual([]);
    expect(useDawStore.getState().layers.showLevels).toBe(false);
  });
});
