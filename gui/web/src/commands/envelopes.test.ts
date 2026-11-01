import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { ApiError } from "../utils/apiError";
import { envelopeTimeRangeMessage } from "../utils/envelopes";
import {
  addEnvelopePointAt,
  envelopeSaveInFlight,
  removeEnvelopePoint,
  setEnvelopePoint,
} from "./envelopes";
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

describe("addEnvelopePointAt", () => {
  const withEnvelope = (duration: number) =>
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        timeline_duration_sec: duration,
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "a", time: 1, value: 1 },
              { id: "b", time: 4, value: 0.5 },
            ],
          },
        ],
      }),
    );

  beforeEach(() => {
    vi.mocked(api.setEnvelope).mockReset().mockResolvedValue(null);
    withEnvelope(10);
    useDawStore.getState().setLayerVisible("showLevels", true);
  });

  it("adds at the level asked for and selects the new point", async () => {
    expect(await addEnvelopePointAt("host", 2, 0.25)).toEqual({ status: "ok" });
    const [, , next] = vi.mocked(api.setEnvelope).mock.calls[0]!;
    expect(next.map(({ time, value }) => ({ time, value }))).toEqual([
      { time: 1, value: 1 },
      { time: 2, value: 0.25 },
      { time: 4, value: 0.5 },
    ]);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "envelopePoint",
      trackId: "host",
      pointId: next[1]!.id,
    });
  });

  it("copies the line's level when none is given", async () => {
    await addEnvelopePointAt("host", 4.0000005);
    expect(api.setEnvelope).not.toHaveBeenCalled();
    await addEnvelopePointAt("host", 6);
    const [, , next] = vi.mocked(api.setEnvelope).mock.calls[0]!;
    expect(next.find((point) => point.time === 6)?.value).toBe(0.5);
  });

  it("refuses when the timeline has no length", async () => {
    withEnvelope(0);
    expect(await addEnvelopePointAt("host", 0)).toMatchObject({
      status: "disabled",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("refuses a view-only link and a time on top of a point", async () => {
    expect(await addEnvelopePointAt("host", 1.0000005)).toEqual({
      status: "disabled",
      reason: "A point is already there",
    });
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
    });
    expect(await addEnvelopePointAt("host", 2, 0.5)).toMatchObject({
      status: "disabled",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("refuses while a save is in flight, and a save refuses while an add is", async () => {
    let release: (undo: null) => void = () => {};
    vi.mocked(api.setEnvelope).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    expect(envelopeSaveInFlight("host")).toBe(false);
    const first = addEnvelopePointAt("host", 2, 0.25);
    expect(envelopeSaveInFlight("host")).toBe(true);
    expect(await addEnvelopePointAt("host", 3, 0.25)).toEqual({
      status: "disabled",
      reason: "Wait for the volume envelope to finish saving",
    });
    expect(await setEnvelopePoint("host", "b", { value: 0.3 })).toMatchObject({
      status: "disabled",
      reason: "Wait for the volume envelope to finish saving",
    });
    release(null);
    expect(await first).toEqual({ status: "ok" });
    expect(envelopeSaveInFlight("host")).toBe(false);
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
  });

  it("frees the track when the save fails", async () => {
    vi.mocked(api.setEnvelope).mockRejectedValueOnce(new Error("offline"));
    expect(await addEnvelopePointAt("host", 2)).toMatchObject({
      status: "disabled",
    });
    expect(envelopeSaveInFlight("host")).toBe(false);
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
      reason: "Wait for the volume envelope to finish saving",
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

  it("takes the end of the timeline as a time but nothing past it", async () => {
    expect(await setEnvelopePoint("host", "b", { time: 10 })).toEqual({
      status: "ok",
    });
    expect(await setEnvelopePoint("host", "b", { value: 1.5 })).toEqual({
      status: "ok",
    });
    expect(await setEnvelopePoint("host", "b", { time: 10.5 })).toEqual({
      status: "disabled",
      reason: envelopeTimeRangeMessage(10),
    });
    expect(api.setEnvelope).toHaveBeenCalledTimes(2);
  });

  it("lets a point left past a shortened timeline change level or go, but not move out (#1336)", async () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        timeline_duration_sec: 3,
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
    expect(await setEnvelopePoint("host", "b", { time: 5 })).toMatchObject({
      status: "disabled",
      reason: envelopeTimeRangeMessage(3),
    });
    expect(await setEnvelopePoint("host", "b", { value: 0.9 })).toEqual({
      status: "ok",
    });
    expect(await setEnvelopePoint("host", "b", { time: 2 })).toEqual({
      status: "ok",
    });
    expect(await removeEnvelopePoint("host", "b")).toEqual({ status: "ok" });
    expect(api.setEnvelope).toHaveBeenCalledTimes(3);
  });

  it("saves for an editor link and refuses a view link", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["edit"],
    });
    expect(await setEnvelopePoint("host", "b", { value: 0.2 })).toEqual({
      status: "ok",
    });
    useDawStore.setState({ shareCapabilities: ["view"] });
    expect(await setEnvelopePoint("host", "b", { value: 0.3 })).toMatchObject({
      status: "disabled",
    });
    expect(api.setEnvelope).toHaveBeenCalledTimes(1);
  });

  it("answers a point that has gone with a refusal, not a save", async () => {
    expect(await setEnvelopePoint("host", "zzz", { value: 0.2 })).toEqual({
      status: "disabled",
      reason: "That point is gone",
    });
    expect(await removeEnvelopePoint("host", "zzz")).toEqual({
      status: "disabled",
      reason: "That point is gone",
    });
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });
});
