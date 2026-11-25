import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import { submitDocumentCommand } from "./documentEdits";
import { apiFetch, HOST_KEY } from "./http";
import {
  type DamagedSegmentRow,
  insertSegment,
  isDamagedSegment,
  loadSegment,
  loadSegmentDrift,
  loadSegments,
  previewSegmentInsert,
  removeSegment,
  type SegmentInsertApplied,
  type SegmentInsertPreview,
  type SegmentRow,
  saveSegment,
  segmentAudioUrl,
  segmentInsertRefusal,
} from "./segments";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

vi.mock("./documentEdits", () => ({ submitDocumentCommand: vi.fn() }));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(submitDocumentCommand).mockReset();
});

describe("segment routes", () => {
  it("lists and tells a damaged row from a readable one", async () => {
    const damaged: DamagedSegmentRow = {
      id: "b-2",
      version: 1,
      damaged: true,
      problem: "changed",
      code: "segment_hash_mismatch",
    };
    const ok = { id: "a-1", versions: [1, 2] } as unknown as SegmentRow;
    vi.mocked(apiFetch).mockResolvedValue(json([ok, damaged]));
    const rows = await loadSegments();
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe(HOST_KEY);
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/segments",
    });
    expect(rows.map(isDamagedSegment)).toEqual([false, true]);
  });

  it("escapes the id when it loads or removes one", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({}));
    await loadSegment("a/b");
    await removeSegment("a/b");
    const calls = vi.mocked(apiFetch).mock.calls;
    expect(calls[0][1]).toEqual({ host: "/api/segments/a%2Fb" });
    expect(calls[1][1]).toEqual({ host: "/api/segments/a%2Fb" });
    expect(calls[1][2]).toMatchObject({ method: "DELETE" });
  });

  it("loads drift for one project, escaping its path", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json([]));
    expect(await loadSegmentDrift("/p/my ep&x.sharecut")).toEqual([]);
    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe(HOST_KEY);
    expect(call[1]).toEqual({
      host: "/api/segments/drift?path=%2Fp%2Fmy%20ep%26x.sharecut",
    });
  });

  it("posts a save and returns the status", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json({ status: "added", id: "a-1", version: 1 }),
    );
    const result = await saveSegment({
      path: "/p/ep.sharecut",
      name: "Intro",
      clip_ids: ["c1"],
    });
    expect(result).toEqual({ status: "added", id: "a-1", version: 1 });
    const init = vi.mocked(apiFetch).mock.calls[0][2];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      path: "/p/ep.sharecut",
      name: "Intro",
      clip_ids: ["c1"],
    });
  });
});

describe("segmentAudioUrl", () => {
  it("defaults to the first clip of the newest version", () => {
    expect(segmentAudioUrl("a-1")).toBe("/api/segments/a-1/audio?clip=0");
  });

  it("carries the clip and version and escapes the id", () => {
    expect(segmentAudioUrl("a/b", 2, 3)).toBe(
      "/api/segments/a%2Fb/audio?clip=2&version=3",
    );
  });
});

describe("segment insert", () => {
  it("submits InsertSegment with the position and pinned version", async () => {
    const applied: SegmentInsertApplied = {
      operation: "insert_segment",
      affected_tracks: ["host"],
      clip_count: 1,
      timeline_duration_sec: 12,
      segment_id: "a-1",
      segment_version: 2,
      at: 4,
      duration_sec: 2,
      tracks: { "0": "t1" },
    };
    vi.mocked(submitDocumentCommand).mockResolvedValue({ ...applied });
    const result = await insertSegment("/p/ep.sharecut", {
      segment_id: "a-1",
      at: "end",
      version: 2,
    });
    expect(result).toEqual(applied);
    expect(submitDocumentCommand).toHaveBeenCalledWith(
      "/p/ep.sharecut",
      "InsertSegment",
      { segment_id: "a-1", at: "end", version: 2 },
    );
  });

  it("sends a numeric position and omits an unset version", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({});
    await insertSegment("/p", { segment_id: "a-1", at: 3.5 });
    expect(vi.mocked(submitDocumentCommand).mock.calls[0][2]).toEqual({
      segment_id: "a-1",
      at: 3.5,
    });
  });

  it("names a refusal code and ignores every other failure", async () => {
    const refused = new ApiError("no", "segment_hash_mismatch", 400);
    vi.mocked(submitDocumentCommand).mockRejectedValue(refused);
    const caught = await insertSegment("/p", {
      segment_id: "a-1",
      at: "start",
    }).catch((e: unknown) => e);
    expect(segmentInsertRefusal(caught)).toBe("segment_hash_mismatch");
    expect(segmentInsertRefusal(new ApiError("x", "other", 400))).toBeNull();
    expect(segmentInsertRefusal(new Error("x"))).toBeNull();
    expect(segmentInsertRefusal(null)).toBeNull();
  });

  it("previews through the read-only route, escaping every part", async () => {
    const preview = { dry_run: true, clips_moved: 1 } as SegmentInsertPreview;
    vi.mocked(apiFetch).mockResolvedValue(json(preview));
    const signal = new AbortController().signal;
    const result = await previewSegmentInsert(
      "/p/my ep&x.sharecut",
      { segment_id: "a/b", at: 4, version: 3 },
      signal,
    );
    expect(result).toEqual(preview);
    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe(HOST_KEY);
    expect(call[1]).toEqual({
      host: "/api/segments/a%2Fb/insert-preview?path=%2Fp%2Fmy+ep%26x.sharecut&at=4&version=3",
    });
    expect(call[2]).toMatchObject({ signal });
    expect(submitDocumentCommand).not.toHaveBeenCalled();
  });

  it("previews the end of the episode on the newest version", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json({}));
    await previewSegmentInsert("/p", { segment_id: "a-1", at: "end" });
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/segments/a-1/insert-preview?path=%2Fp&at=end",
    });
  });
});
