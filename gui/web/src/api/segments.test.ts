import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDamagedSegment,
  loadSegments,
  removeSegment,
  saveSegment,
  segmentAudioUrl,
} from "./segments";

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("segment library API", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply([])),
    );
  });

  it("lists the library from the host route and keeps a damaged row", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      reply([
        { id: "warm-intro-1a2b3c4d", name: "Warm Intro", versions: [1] },
        {
          id: "old-0000aaaa",
          version: 2,
          damaged: true,
          problem: "audio missing",
          code: "segment_hash_mismatch",
        },
      ]),
    );

    const rows = await loadSegments();

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      "/api/segments",
    );
    expect(rows.map(isDamagedSegment)).toEqual([false, true]);
  });

  it("posts a save as JSON and returns its status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      reply({ status: "added", id: "bumper-1a2b3c4d", version: 1 }),
    );

    const result = await saveSegment({
      path: "/tmp/episode.sharecut",
      name: "Bumper",
      time_range: "0:00-0:05",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "/tmp/episode.sharecut",
      name: "Bumper",
      time_range: "0:00-0:05",
    });
    expect(result).toEqual({
      status: "added",
      id: "bumper-1a2b3c4d",
      version: 1,
    });
  });

  it("carries the service's error code on a refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "No such segment." }), {
        status: 404,
        headers: { "X-Sharecut-Error-Code": "segment_unknown" },
      }),
    );

    await expect(removeSegment("nope-00000000")).rejects.toMatchObject({
      name: "ApiError",
      code: "segment_unknown",
    });
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("builds the audio URL with the clip and version, escaped", () => {
    const url = segmentAudioUrl("a b", 1, 2);

    expect(url).toContain("/api/segments/a%20b/audio?clip=1&version=2");
    expect(segmentAudioUrl("x-00000000")).toContain("clip=0");
    expect(segmentAudioUrl("x-00000000")).not.toContain("version=");
  });
});
