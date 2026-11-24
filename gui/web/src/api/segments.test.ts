import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HOST_KEY } from "./http";
import {
  type DamagedSegmentRow,
  isDamagedSegment,
  loadSegment,
  loadSegments,
  removeSegment,
  type SegmentRow,
  saveSegment,
  segmentAudioUrl,
} from "./segments";

vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: vi.fn(),
}));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
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
    expect(JSON.parse(String(init?.body))).toEqual({
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
