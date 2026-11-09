import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLL_CONFLICT_MESSAGE } from "../../../commands/seamCommands";
import { useDawStore } from "../../../state/dawStore";
import {
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../../../test/fixtures";
import { useScriptSeamRoll } from "./useScriptSeamRoll";

const rollSeam = vi.hoisted(() => vi.fn());
const replayIfInspected = vi.hoisted(() => vi.fn());
vi.mock("../../../commands/seamCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../commands/seamCommands")>()),
  rollSeam,
  replayIfInspected,
}));

const TRACK = "mira-voice";
const L = clipRow({
  id: "L",
  source_start: 0,
  source_end: 4,
  source_duration_sec: 20,
  timeline_start: 0,
  timeline_end: 4,
});
const R = clipRow({
  id: "R",
  source_start: 4,
  source_end: 10,
  timeline_start: 4,
  timeline_end: 10,
});

beforeEach(() => {
  rollSeam.mockReset();
  replayIfInspected.mockReset();
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: TRACK })],
      clips: { tracks: { [TRACK]: [L, R] }, clip_count: 2 },
      edit_boundaries: editBoundaries([L, R]),
    }),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
  });
});

describe("useScriptSeamRoll", () => {
  it("reads the roll's reach in ms and refuses while a seam save is in flight", () => {
    const { result } = renderHook(() => useScriptSeamRoll(vi.fn()));
    expect(result.current.limits("eb:L:R")).toEqual({
      minMs: -3950,
      maxMs: 5950,
    });
    useDawStore.setState({ joinMutationInFlight: true });
    expect(result.current.limits("eb:L:R")).toBeNull();
  });

  it("says a failed roll once, with its reason", async () => {
    const say = vi.fn();
    rollSeam.mockResolvedValue({ status: "failed", message: "disk full" });
    const { result } = renderHook(() => useScriptSeamRoll(say));
    result.current.commit("eb:L:R", 5);
    await vi.waitFor(() => expect(say).toHaveBeenCalledTimes(1));
    expect(say).toHaveBeenCalledWith("Could not roll the seam. disk full");
    expect(replayIfInspected).not.toHaveBeenCalled();
  });

  it("says a stale roll in the conflict words", async () => {
    const say = vi.fn();
    rollSeam.mockResolvedValue({
      status: "failed",
      message: ROLL_CONFLICT_MESSAGE,
    });
    const { result } = renderHook(() => useScriptSeamRoll(say));
    result.current.commit("eb:L:R", 5);
    await vi.waitFor(() => expect(say).toHaveBeenCalledTimes(1));
    expect(say).toHaveBeenCalledWith(
      "Could not roll the seam. The seam moved before the roll saved. Nothing changed.",
    );
  });

  it("replays that seam after a saved roll and stays quiet", async () => {
    const say = vi.fn();
    rollSeam.mockResolvedValue({ status: "done" });
    const { result } = renderHook(() => useScriptSeamRoll(say));
    result.current.commit("eb:L:R", 5);
    await vi.waitFor(() =>
      expect(replayIfInspected).toHaveBeenCalledWith("eb:L:R"),
    );
    expect(rollSeam).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eb:L:R" }),
      5,
    );
    expect(say).not.toHaveBeenCalled();
  });

  it("rolls nothing for a seam the project no longer has", () => {
    const { result } = renderHook(() => useScriptSeamRoll(vi.fn()));
    result.current.commit("eb:gone:R", 5);
    expect(rollSeam).not.toHaveBeenCalled();
  });
});
