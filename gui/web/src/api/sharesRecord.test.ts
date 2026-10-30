import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { createHostShare, loadHostRecordSessions } from "./sharesRecord";

const hostFetch = vi.fn();

describe("createHostShare", () => {
  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the typed stale-mix conflict for recovery callers", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Refresh the mix first." }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "stale_mix" },
      }),
    );

    await expect(
      createHostShare("/tmp/episode.sharecut", { role: "commenter" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "stale_mix",
      status: 409,
      message: "Refresh the mix first.",
    });
  });
});

describe("loadHostRecordSessions", () => {
  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the sessions list from the host route", async () => {
    const sessions = [
      {
        session_id: "aaaaaaaaaaaa",
        number: 1,
        state: "ended",
        target_kind: "end",
        takes: [{ take_index: 0, recording_ms: 3000 }],
        participants: [],
        landed: true,
        ended_at: "2026-01-02T00:00:00+00:00",
      },
    ];
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ sessions }), { status: 200 }),
    );

    await expect(
      loadHostRecordSessions("/tmp/ep isode.sharecut"),
    ).resolves.toEqual(sessions);
    expect(String(hostFetch.mock.calls[0][0])).toContain(
      "/api/record/sessions?path=%2Ftmp%2Fep%20isode.sharecut",
    );
  });

  it("returns no sessions for a guest share without asking the host route", async () => {
    await expect(
      loadHostRecordSessions(shareProjectKey("tok")),
    ).resolves.toEqual([]);
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("surfaces a failed response as an ApiError", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "nope" }), { status: 500 }),
    );

    await expect(
      loadHostRecordSessions("/tmp/episode.sharecut"),
    ).rejects.toMatchObject({ name: "ApiError", status: 500 });
  });
});
