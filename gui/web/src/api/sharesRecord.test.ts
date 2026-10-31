import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import {
  createHostRecordRoom,
  createHostShare,
  loadHostRecordSessions,
} from "./sharesRecord";

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
        name: null,
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

describe("createHostRecordRoom", () => {
  const link = (role: string) => ({
    token: `${role}-token`,
    url: `https://example.test/rec/${role}-token`,
    kind: "record",
    record_role: role,
    session_id: "new-room",
  });
  const room = {
    session_id: "new-room",
    guest: link("guest"),
    producer: link("producer"),
  };

  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the room with no stale sessions when every earlier link was revoked", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ room }), { status: 200 }),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).resolves.toEqual({ ...room, linksStale: false });
  });

  it("treats a stale-links 409 as a made room and names the earlier sessions", async () => {
    hostFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            error: "record_stale_links",
            message: "New record room new-room is ready",
            room,
            stale_session_ids: ["old-1", "old-2"],
          },
        }),
        {
          status: 409,
          headers: { "X-Sharecut-Error-Code": "record_stale_links" },
        },
      ),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).resolves.toEqual({ ...room, linksStale: true });
  });

  it("still rejects any other conflict, and a stale-links body without a room", async () => {
    hostFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "A room is already open." }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "record_room_unavailable" },
      }),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).rejects.toMatchObject({ code: "record_room_unavailable" });

    hostFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { room } }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "record_room_unavailable" },
      }),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).rejects.toMatchObject({ code: "record_room_unavailable" });

    hostFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { room } }), {
        status: 500,
        headers: { "X-Sharecut-Error-Code": "record_stale_links" },
      }),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).rejects.toMatchObject({ status: 500 });

    hostFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { stale_session_ids: ["old"] } }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "record_stale_links" },
      }),
    );
    await expect(
      createHostRecordRoom("/tmp/episode.sharecut"),
    ).rejects.toMatchObject({ code: "record_stale_links" });
  });
});
