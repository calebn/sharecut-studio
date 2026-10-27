import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTranscriptCheck, markTranscriptChecked } from "./transcriptCheck";

const status = {
  status: "done",
  clear: true,
  stale: false,
  mode: "waive_unattended",
  source: "user",
  notes: "",
  updated_at: "2026-10-27T10:00:00+00:00",
  hint: null,
  low_confidence_words: 3,
  low_confidence_threshold: 0.7,
};

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  throw new Error("fetch was called without a URL");
}

describe("transcript check client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the gate status for the project path", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(status)));
    await expect(loadTranscriptCheck("/tmp/p.json")).resolves.toEqual(status);
    const [url] = fetch.mock.calls[0] ?? [];
    expect(requestUrl(url)).toContain(
      "/api/transcript/refine/status?path=%2Ftmp%2Fp.json",
    );
  });

  it("posts the path and optional notes to mark the transcript checked", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(status)));
    await expect(markTranscriptChecked("/tmp/p.json")).resolves.toEqual(status);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(requestUrl(url)).toContain("/api/transcript/refine/done");
    expect(init?.method).toBe("POST");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({ path: "/tmp/p.json" });
  });

  it("surfaces a refusal from the server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Not allowed" }), { status: 403 }),
    );
    await expect(markTranscriptChecked("/tmp/p.json")).rejects.toThrow(
      "Not allowed",
    );
  });

  it("refuses shared guests without sending a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(loadTranscriptCheck("share:guest")).rejects.toThrow(
      "only available to the host",
    );
    await expect(markTranscriptChecked("share:guest")).rejects.toThrow(
      "only available to the host",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
