import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import {
  fetchPendingAuditionSide,
  parsePendingAuditionSpan,
  REVIEW_AUDITION_PAD_SEC,
  warmPendingAudition,
} from "./pendingPreview";

const HEADERS = {
  "X-Preview-Edit-Id": "cut1",
  "X-Preview-Mode": "current",
  "X-Preview-Pad-Sec": "3",
  "X-Preview-Start-Sec": "0",
  "X-Preview-End-Sec": "5.6",
  "X-Preview-Edit-Start-Sec": "2",
  "X-Preview-Edit-End-Sec": "2.6",
};

function wav(headers: Record<string, string> = HEADERS) {
  return new Response(new Uint8Array([82, 73, 70, 70]), {
    status: 200,
    headers: { "content-type": "audio/wav", ...headers },
  });
}

function calledUrl(index: number): string {
  const input = vi.mocked(fetch).mock.calls[index][0];
  if (typeof input !== "string") throw new Error("expected a string URL");
  return input;
}

describe("pending audition API", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => wav()),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the original and the edited result as two files, 3 s either side", async () => {
    const a = await fetchPendingAuditionSide("/tmp/episode.json", "cut1", "A");
    const b = await fetchPendingAuditionSide("/tmp/episode.json", "cut1", "B");
    const urls = [calledUrl(0), calledUrl(1)];
    expect(urls[0]).toContain("/api/pending-preview?");
    const first = new URL(urls[0], "http://host").searchParams;
    expect(Object.fromEntries(first)).toEqual({
      path: "/tmp/episode.json",
      edit_id: "cut1",
      mode: "current",
      pad_sec: String(REVIEW_AUDITION_PAD_SEC),
    });
    expect(new URL(urls[1], "http://host").searchParams.get("mode")).toBe(
      "suggested",
    );
    expect([a.side, b.side]).toEqual(["A", "B"]);
    expect(a.blob.size).toBe(4);
  });

  it("sends the padding it was given and reads where the file sits", async () => {
    const file = await fetchPendingAuditionSide(
      "/tmp/episode.json",
      "cut1",
      "A",
      { padSec: 1.5 },
    );
    const url = new URL(calledUrl(0), "http://h");
    expect(url.searchParams.get("pad_sec")).toBe("1.5");
    expect(file.span).toEqual({
      editId: "cut1",
      padSec: 3,
      startSec: 0,
      endSec: 5.6,
      editStartSec: 2,
      editEndSec: 2.6,
    });
  });

  it("uses the guest twin for a share", async () => {
    await fetchPendingAuditionSide("share:abc", "cut1", "B");
    const url = calledUrl(0);
    expect(url).toContain("/daw/pending-preview?");
    expect(url).not.toContain("path=");
    expect(url).toContain("mode=suggested");
  });

  it.each([-1, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a padding of %s before asking",
    async (padSec) => {
      await expect(
        fetchPendingAuditionSide("/tmp/episode.json", "cut1", "A", { padSec }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("surfaces the server's refusal with its code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: "A split does not change the mix." }),
        {
          status: 400,
          headers: { "X-Sharecut-Error-Code": "pending_preview_unavailable" },
        },
      ),
    );
    await expect(
      fetchPendingAuditionSide("/tmp/episode.json", "cut1", "B"),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "pending_preview_unavailable",
    });
  });

  it("rejects a response without the placement headers", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(wav({}));
    await expect(
      fetchPendingAuditionSide("/tmp/episode.json", "cut1", "A"),
    ).rejects.toBeInstanceOf(ApiError);
    expect(() => parsePendingAuditionSpan(new Headers())).toThrow(
      /X-Preview-Edit-Id/,
    );
  });

  it("warms the pad the card will play, and a guest has nothing to warm", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ sides: { current: "ready", suggested: "ready" } }),
    );
    expect(await warmPendingAudition("/tmp/episode.json", "cut1")).toBe(true);
    expect(calledUrl(0)).toContain("/api/pending-preview/warm?");
    expect(calledUrl(0)).toContain("pad_sec=3");
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("POST");
    expect(await warmPendingAudition("share:abc", "cut1")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ sides: { suggested: "failed" } }),
    );
    expect(await warmPendingAudition("/tmp/episode.json", "cut1")).toBe(false);
  });
});
