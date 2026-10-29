import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSplitSpeakersJob } from "./speakerSplit";

const hostFetch = vi.fn();

describe("startSplitSpeakersJob", () => {
  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the count and names for the track and returns the job", async () => {
    const job = { id: "s1", kind: "split_speakers" };
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ job }), { status: 200 }),
    );
    await expect(
      startSplitSpeakersJob("/tmp/ep/episode.sharecut", {
        trackId: "room",
        speakerCount: 3,
        names: ["Ana", "Ben", "Cy"],
        enrollment: { Ana: [[1.5, 6]] },
      }),
    ).resolves.toEqual(job);
    const [url, init] = hostFetch.mock.calls[0]!;
    expect(url).toBe("/api/speaker/split");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      path: "/tmp/ep/episode.sharecut",
      track_id: "room",
      speaker_count: 3,
      names: ["Ana", "Ben", "Cy"],
      enrollment: { Ana: [[1.5, 6]] },
    });
  });

  it("throws the server's reason when the split is refused", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "track room is already split" }), {
        status: 400,
      }),
    );
    await expect(
      startSplitSpeakersJob("/tmp/ep/episode.sharecut", {
        trackId: "room",
        speakerCount: 2,
        names: null,
        enrollment: null,
      }),
    ).rejects.toThrow("track room is already split");
  });
});
