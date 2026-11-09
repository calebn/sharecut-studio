import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { type Seam, seamById } from "../../edit/seam";
import { useDawStore } from "../../state/dawStore";
import {
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { AB_CLAMPED_REASON, useSeamAudition } from "./useSeamAudition";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadBoundaryContext: vi.fn(),
  auditionBoundary: vi.fn(),
  fetchBoundaryAudio: vi.fn(),
}));

const PATH = "/tmp/episode";

function lane(leftEnd: number): ClipRow[] {
  return [
    clipRow({
      id: "L",
      track_id: "host",
      source_id: "long",
      source_start: 6,
      source_end: leftEnd,
      source_duration_sec: 30,
      timeline_start: 0,
      timeline_end: leftEnd - 6,
    }),
    clipRow({
      id: "R",
      track_id: "host",
      source_id: "long",
      source_start: leftEnd,
      source_end: 14,
      source_duration_sec: 30,
      timeline_start: leftEnd - 6,
      timeline_end: leftEnd - 6 + (14 - leftEnd),
    }),
  ];
}

function load(leftEnd: number): Seam {
  const clips = lane(leftEnd);
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: clips }, clip_count: 2 },
      edit_boundaries: editBoundaries(clips),
    }),
    projectPath: PATH,
  });
  const project = useDawStore.getState().project;
  const seam = project ? seamById(project, "eb:L:R") : null;
  if (!seam) throw new Error("no seam");
  return seam;
}

function windowOf(side: string, duration: number) {
  return {
    url: `/api/boundary/audition/opaque/${side}`,
    window_start_sec: 0,
    window_end_sec: duration,
    duration_sec: duration,
    seam_offset_sec: 1.5,
  };
}

function answer(deltaSec: number) {
  return {
    token: "ctx-token",
    actual_edit: {
      kind: "roll" as const,
      left_clip_id: "L",
      right_clip_id: "R",
      delta_sec: deltaSec,
    },
    current: windowOf("current", 3),
    proposed: windowOf("proposed", 3.1),
  };
}

let nextUrl = 0;
const revoke = vi.fn();

beforeEach(() => {
  nextUrl = 0;
  revoke.mockReset();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => `blob:ab-${++nextUrl}`),
    revokeObjectURL: revoke,
  });
  vi.mocked(api.loadBoundaryContext)
    .mockReset()
    .mockResolvedValue({ token: "ctx-token" } as Awaited<
      ReturnType<typeof api.loadBoundaryContext>
    >);
  vi.mocked(api.auditionBoundary)
    .mockReset()
    .mockImplementation(async (_p, _t, edit) =>
      answer("delta_sec" in edit ? edit.delta_sec : 0),
    );
  vi.mocked(api.fetchBoundaryAudio)
    .mockReset()
    .mockResolvedValue(new Blob(["wav"]));
  useDawStore.setState({
    sourcePreview: null,
    projectEpoch: 1,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSeamAudition", () => {
  it("auditions the reverse roll once and plays A from the proposed window and B from the current one (a same-recording roll unions both clips' mute regions, so A is the pre-roll audio only where the mutes do not overlap)", async () => {
    const seam = load(10.0123);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("A"));
    expect(result.current.pending).toBe(true);
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview?.ownerId).toBe(
        "seam-ab:eb:L:R",
      ),
    );
    expect(api.auditionBoundary).toHaveBeenCalledTimes(1);
    const call = vi.mocked(api.auditionBoundary).mock.calls[0];
    expect(call?.[1]).toEqual({
      kind: "roll",
      left_clip_id: "L",
      right_clip_id: "R",
    });
    expect(call?.[2]).toMatchObject({ kind: "roll" });
    expect((call?.[2] as { delta_sec: number }).delta_sec).toBeCloseTo(
      -0.0123,
      9,
    );
    expect(call?.[3]).toBe("ctx-token");
    expect(call?.[5]).toBe(1.5);
    expect(api.fetchBoundaryAudio).toHaveBeenCalledWith(
      "/api/boundary/audition/opaque/proposed",
      "ctx-token",
      expect.any(AbortSignal),
    );
    expect(useDawStore.getState().sourcePreview).toMatchObject({
      media: { kind: "rendered", url: "blob:ab-1" },
      startSec: 0,
      endSec: 3.1,
    });
    expect(result.current.pending).toBe(false);

    act(() => result.current.play("B"));
    expect(api.auditionBoundary).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().sourcePreview).toMatchObject({
      media: { kind: "rendered", url: "blob:ab-2" },
      endSec: 3,
    });
    expect(result.current.side).toBe("B");
  });

  it("asks for nothing while the seam is where it was", () => {
    const seam = load(10);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("A"));
    expect(api.loadBoundaryContext).not.toHaveBeenCalled();
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });

  it("refuses a comparison the seam cannot return to and plays nothing", async () => {
    vi.mocked(api.auditionBoundary).mockResolvedValueOnce(answer(-0.01));
    const seam = load(10.0123);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("A"));
    await waitFor(() => expect(result.current.error).toBe(AB_CLAMPED_REASON));
    expect(AB_CLAMPED_REASON).toBe("The seam can't return to where it was");
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(api.fetchBoundaryAudio).not.toHaveBeenCalled();
  });

  it("revokes the cached windows and releases the preview when the seam moves again", async () => {
    const first = load(10.0123);
    const { result, rerender } = renderHook(
      ({ seam }) => useSeamAudition(seam, 10),
      { initialProps: { seam: first } },
    );
    act(() => result.current.play("A"));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    rerender({ seam: load(10.03) });
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([
      "blob:ab-1",
      "blob:ab-2",
    ]);
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(result.current.side).toBe("B");
  });

  it("revokes the cached windows once Undo brings the seam back and on unmount", async () => {
    const first = load(10.0123);
    const { result, rerender, unmount } = renderHook(
      ({ seam }) => useSeamAudition(seam, 10),
      { initialProps: { seam: first } },
    );
    act(() => result.current.play("B"));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    rerender({ seam: load(10) });
    expect(revoke).toHaveBeenCalledTimes(2);
    unmount();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("aborts a request in flight when the seam changes and drops its answer", async () => {
    let release: () => void = () => undefined;
    vi.mocked(api.fetchBoundaryAudio).mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => resolve(new Blob(["wav"]));
        }),
    );
    const first = load(10.0123);
    const { result, rerender } = renderHook(
      ({ seam }) => useSeamAudition(seam, 10),
      { initialProps: { seam: first } },
    );
    act(() => result.current.play("A"));
    await waitFor(() => expect(api.fetchBoundaryAudio).toHaveBeenCalled());
    const signal = vi.mocked(api.fetchBoundaryAudio).mock.calls[0]?.[2];
    rerender({ seam: load(10.03) });
    expect(signal?.aborted).toBe(true);
    await act(async () => release());
    expect(useDawStore.getState().sourcePreview).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("shows a failed audition as the server's words and leaves A and B available", async () => {
    vi.mocked(api.auditionBoundary).mockRejectedValueOnce(
      new Error("409 boundary preview is stale"),
    );
    const seam = load(10.0123);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("A"));
    await waitFor(() =>
      expect(result.current.error).toBe("409 boundary preview is stale"),
    );
    expect(result.current.pending).toBe(false);
  });

  it("fetches a fresh comparison after a fade changes with the geometry fixed", async () => {
    const first = load(10.0123);
    const { result, rerender } = renderHook(
      ({ seam }) => useSeamAudition(seam, 10),
      { initialProps: { seam: first } },
    );
    act(() => result.current.play("B"));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    expect(api.auditionBoundary).toHaveBeenCalledTimes(1);
    const faded = {
      ...first,
      right: { ...first.right, fade_out_ms: 200 },
    };
    rerender({ seam: faded });
    expect(useDawStore.getState().sourcePreview).toBeNull();
    act(() => result.current.play("B"));
    await waitFor(() => expect(api.auditionBoundary).toHaveBeenCalledTimes(2));
  });

  it("fetches a fresh comparison after the track gain changes", async () => {
    const seam = load(10.0123);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("B"));
    await waitFor(() =>
      expect(useDawStore.getState().sourcePreview).not.toBeNull(),
    );
    act(() => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("no project");
      useDawStore.setState({
        project: {
          ...project,
          tracks: project.tracks.map((t) => ({ ...t, gain_db: -6 })),
        },
      });
    });
    expect(useDawStore.getState().sourcePreview).toBeNull();
    act(() => result.current.play("B"));
    await waitFor(() => expect(api.auditionBoundary).toHaveBeenCalledTimes(2));
  });

  it("says a stale audition in the roll conflict words", async () => {
    vi.mocked(api.auditionBoundary).mockRejectedValueOnce(
      new ApiError("boundary preview is stale", "document_conflict", 409),
    );
    const seam = load(10.0123);
    const { result } = renderHook(() => useSeamAudition(seam, 10));
    act(() => result.current.play("A"));
    await waitFor(() =>
      expect(result.current.error).toBe(
        "The seam moved before the roll saved. Nothing changed.",
      ),
    );
  });
});
