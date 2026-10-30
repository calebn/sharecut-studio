import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { BUSY_REASON } from "../ui/disabledReason";
import { ApiError } from "../utils/apiError";
import { removeEnvelopePoint, setEnvelopePoint } from "./envelopes";
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

describe("envelope point writes", () => {
  const points = [
    { id: "a", time: 1, value: 1 },
    { id: "b", time: 4, value: 0.5 },
  ];

  beforeEach(() => {
    vi.mocked(api.setEnvelope).mockReset().mockResolvedValue(null);
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        timeline_duration_sec: 10,
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: structuredClone(points),
          },
        ],
      }),
    );
    useDawStore.getState().setLayerVisible("showLevels", true);
  });

  it("moves one point in one save against the points it read", async () => {
    expect(
      await setEnvelopePoint("host", "b", { time: 6, value: 0.8 }),
    ).toEqual({
      status: "ok",
    });
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [points[0], { id: "b", time: 6, value: 0.8 }],
      points,
    );
  });

  it("saves nothing for a point left where it was", async () => {
    expect(await setEnvelopePoint("host", "b", { time: 4 })).toEqual({
      status: "ok",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("names the point already at that time", async () => {
    expect(await setEnvelopePoint("host", "b", { time: 1 })).toMatchObject({
      status: "disabled",
      collisionId: "a",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    [{ time: 11 }, "timeline"],
    [{ value: 1.6 }, "Level"],
    [{ time: -1 }, "Time"],
  ])("refuses %j before saving", async (edit, word) => {
    const written = await setEnvelopePoint("host", "b", edit);
    expect(written).toMatchObject({ status: "disabled" });
    expect(JSON.stringify(written)).toContain(word);
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("refuses while the volume envelope is hidden and for a view-only link", async () => {
    useDawStore.getState().setLayerVisible("showLevels", false);
    expect(await setEnvelopePoint("host", "b", { value: 0.2 })).toMatchObject({
      status: "disabled",
      reason: "Show the volume envelope before changing points",
    });
    useDawStore.getState().setLayerVisible("showLevels", true);
    useDawStore.setState({ projectPath: "share:tok", shareCapabilities: [] });
    expect(await removeEnvelopePoint("host", "b")).toMatchObject({
      status: "disabled",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("lets one save finish before the next starts", async () => {
    let release: (undo: null) => void = () => {};
    vi.mocked(api.setEnvelope).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = setEnvelopePoint("host", "b", { value: 0.2 });
    expect(await setEnvelopePoint("host", "b", { value: 0.3 })).toMatchObject({
      status: "disabled",
      reason: BUSY_REASON,
    });
    release(null);
    expect(await first).toEqual({ status: "ok" });
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
  });

  it("reports a host conflict so the sheet can offer a reload", async () => {
    vi.mocked(api.setEnvelope).mockRejectedValueOnce(
      new ApiError("The envelope changed", "conflict", 409),
    );
    expect(await setEnvelopePoint("host", "b", { value: 0.2 })).toEqual({
      status: "disabled",
      reason: "The envelope changed",
      conflict: true,
    });
  });

  it("removes a point with its Undo and keeps the envelope selected", async () => {
    expect(await removeEnvelopePoint("host", "b")).toEqual({ status: "ok" });
    expect(api.setEnvelope).toHaveBeenCalledWith(
      "/tmp/p.json",
      "host",
      [points[0]],
      points,
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelope",
      trackId: "host",
    });
  });
});
