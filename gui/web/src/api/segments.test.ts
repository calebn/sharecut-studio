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
  SEGMENT_INSERT_APPLIED_KEYS,
  SEGMENT_INSERT_PREVIEW_KEYS,
  type SegmentInsertApplied,
  type SegmentInsertPreview,
  type SegmentRow,
  saveSegment,
  segmentAudioUrl,
  segmentInsertRefusal,
  segmentSaveRefusal,
} from "./segments";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

vi.mock("./documentEdits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));

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

describe("segmentSaveRefusal", () => {
  it("names a save refusal code and ignores every other failure", () => {
    for (const code of [
      "segment_clip_too_short",
      "segment_render_unsupported",
      "segment_busy",
      "segment_write_failed",
      "segment_invalid",
      "segment_name_invalid",
    ])
      expect(segmentSaveRefusal(new ApiError("x", code, 400))).toBe(code);
    expect(segmentSaveRefusal(new ApiError("x", "other", 400))).toBeNull();
    expect(segmentSaveRefusal(new ApiError("x", null, 500))).toBeNull();
    expect(segmentSaveRefusal(new Error("x"))).toBeNull();
    expect(segmentSaveRefusal(undefined)).toBeNull();
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

const envelope = (result: unknown, head: string | null = "h-9") => ({
  ok: true,
  command: { type: "InsertSegment", payload: { result } },
  history_head_id: head,
});

const preview: SegmentInsertPreview = {
  dry_run: true,
  segment_id: "a-1",
  segment_version: 2,
  at: 4,
  duration_sec: 2,
  timeline_duration_before_sec: 8,
  timeline_duration_after_sec: 10,
  clips_moved: 1,
  clips_added: 2,
  clips_from_segment: 1,
  chapters_moved: [{ title: "Later", from: 6, to: 8 }],
  chapter_added: "Welcome",
  comments_moved: [{ id: "c1", from: 5, to: 7 }],
  pending_edits_moved: 0,
  tracks_added: ["t1"],
  tracks: { "0": "t1" },
};

describe("segment insert", () => {
  it("unwraps the applied result and the history head from the reply", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue(envelope(applied));
    const result = await insertSegment("/p/ep.sharecut", {
      segment_id: "a-1",
      at: "end",
      version: 2,
    });
    expect(result).toEqual({
      queued: false,
      applied,
      historyHead: "h-9",
    });
    expect(submitDocumentCommand).toHaveBeenCalledWith(
      "/p/ep.sharecut",
      "InsertSegment",
      { segment_id: "a-1", at: "end", version: 2 },
      undefined,
    );
  });

  it("reports a queued reply without a result or a head", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      ok: true,
      queued: true,
      command_id: "c-1",
      client_seq: 3,
    });
    expect(await insertSegment("/p", { segment_id: "a-1", at: 3.5 })).toEqual({
      queued: true,
      historyHead: null,
    });
    expect(vi.mocked(submitDocumentCommand).mock.calls[0][2]).toEqual({
      segment_id: "a-1",
      at: 3.5,
    });
  });

  it("forwards the command options", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue(envelope(applied));
    await insertSegment(
      "/p",
      { segment_id: "a-1", at: 1 },
      {
        command_id: "cmd-7",
      },
    );
    expect(vi.mocked(submitDocumentCommand).mock.calls[0][3]).toEqual({
      command_id: "cmd-7",
    });
  });

  it("refuses a reply that holds no insert result", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({ ok: true });
    await expect(
      insertSegment("/p", { segment_id: "a-1", at: 1 }),
    ).rejects.toThrow("missing its result");
    vi.mocked(submitDocumentCommand).mockResolvedValue(
      envelope({ operation: "insert_segment", at: "4" }),
    );
    await expect(
      insertSegment("/p", { segment_id: "a-1", at: 1 }),
    ).rejects.toThrow("malformed");
  });

  it("names a refusal code and ignores every other failure", async () => {
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new ApiError("no", "segment_hash_mismatch", 400),
    );
    const caught = await insertSegment("/p", {
      segment_id: "a-1",
      at: "start",
    }).catch((e: unknown) => e);
    expect(segmentInsertRefusal(caught)).toBe("segment_hash_mismatch");
    for (const code of [
      "segment_version_invalid",
      "segment_unreadable",
      "segment_busy",
    ])
      expect(segmentInsertRefusal(new ApiError("x", code, 400))).toBe(code);
    expect(segmentInsertRefusal(new ApiError("x", "other", 400))).toBeNull();
    expect(segmentInsertRefusal(new Error("x"))).toBeNull();
    expect(segmentInsertRefusal(null)).toBeNull();
  });

  it("previews through the read-only route, escaping every part", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(preview));
    const signal = new AbortController().signal;
    const result = await previewSegmentInsert(
      "/p/my ep&x.sharecut",
      { segment_id: "a/b", at: 4, version: 3 },
      signal,
    );
    expect(result).toEqual(preview);
    expect(Object.keys(result).sort()).toEqual(
      [...SEGMENT_INSERT_PREVIEW_KEYS].sort(),
    );
    const call = vi.mocked(apiFetch).mock.calls[0];
    expect(call[0]).toBe(HOST_KEY);
    expect(call[1]).toEqual({
      host: "/api/segments/a%2Fb/insert-preview?path=%2Fp%2Fmy+ep%26x.sharecut&at=4&version=3",
    });
    expect(call[2]).toMatchObject({ signal });
    expect(submitDocumentCommand).not.toHaveBeenCalled();
  });

  it("previews the end of the episode on the newest version", async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(preview));
    await previewSegmentInsert("/p", { segment_id: "a-1", at: "end" });
    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({
      host: "/api/segments/a-1/insert-preview?path=%2Fp&at=end",
    });
  });

  it("lists exactly the keys of the applied fixture", () => {
    expect(Object.keys(applied).sort()).toEqual(
      [...SEGMENT_INSERT_APPLIED_KEYS].sort(),
    );
  });
});
