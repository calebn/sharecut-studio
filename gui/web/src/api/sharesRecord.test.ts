import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import {
  createHostRecordRoom,
  createHostShare,
  loadHostRecordSessions,
  restoreHostRoom,
  restoreHostShare,
  restoreRefusal,
  revokeHostRoom,
  revokeHostShare,
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
        planned_number: 1,
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

  it("treats a stale-links 409 as a made room", async () => {
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

  it("treats a stale-links 409 with no session ids as a made room too", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: { room } }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "record_stale_links" },
      }),
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

describe("host revoke and restore", () => {
  const project = "/tmp/episode.sharecut";
  const json = (body: unknown, status = 200, code?: string) =>
    new Response(JSON.stringify(body), {
      status,
      headers: code ? { "X-Sharecut-Error-Code": code } : {},
    });
  const sent = (call = 0) => ({
    url: String(hostFetch.mock.calls[call][0]),
    body: JSON.parse(String(hostFetch.mock.calls[call][1].body)),
  });

  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("revokes for good by default and reports no undo window", async () => {
    hostFetch.mockResolvedValue(json({ revoked: true, token: "tok" }));

    await expect(revokeHostShare(project, "tok")).resolves.toEqual({
      restorableUntil: null,
      restoreMs: null,
    });
    expect(sent().url).toContain("/api/shares/tok/revoke");
    expect(sent().body).toEqual({ path: project });
  });

  it("asks for a restorable revoke and returns the server's remaining time", async () => {
    hostFetch.mockResolvedValue(
      json({
        revoked: true,
        token: "tok",
        restorable_until: "2030-01-01T00:00:10+00:00",
        restore_ms: 9800,
      }),
    );

    await expect(
      revokeHostShare(project, "tok", { restorable: true }),
    ).resolves.toEqual({
      restorableUntil: "2030-01-01T00:00:10+00:00",
      restoreMs: 9800,
    });
    expect(sent().body).toEqual({ path: project, restorable: true });
  });

  it("asks for a restorable room revoke", async () => {
    hostFetch.mockResolvedValue(
      json({
        session_id: "room a",
        revoked: ["g", "p"],
        restorable_until: "2030-01-01T00:00:10+00:00",
        restore_ms: 10000,
      }),
    );

    await expect(
      revokeHostRoom(project, "room a", { restorable: true }),
    ).resolves.toMatchObject({ restoreMs: 10000 });
    expect(sent().url).toContain("/api/shares/rooms/room%20a/revoke");
    expect(sent().body).toEqual({ path: project, restorable: true });
  });

  it("restores a link and a room with a POST naming the project", async () => {
    hostFetch.mockResolvedValue(json({ restored: true, token: "tok" }));
    await restoreHostShare(project, "tok");
    hostFetch.mockResolvedValue(json({ session_id: "r1", restored: ["g"] }));
    await restoreHostRoom(project, "r1");

    expect(sent(0).url).toContain("/api/shares/tok/restore");
    expect(sent(1).url).toContain("/api/shares/rooms/r1/restore");
    expect(sent(1).body).toEqual({ path: project });
  });

  it.each([
    [410, "restore_window_closed"],
    [409, "record_room_conflict"],
  ])("types the %i %s refusal", async (status, code) => {
    hostFetch.mockResolvedValue(json({ detail: "refused" }, status, code));

    const error = await restoreHostRoom(project, "r1").catch((e) => e);

    expect(error).toMatchObject({ name: "ApiError", status, code });
    expect(restoreRefusal(error)).toBe(code);
  });

  it("does not read another failure as a restore refusal", async () => {
    hostFetch.mockResolvedValue(json({ detail: "boom" }, 500, "internal"));
    const error = await restoreHostShare(project, "tok").catch((e) => e);

    expect(restoreRefusal(error)).toBeNull();
    expect(restoreRefusal(new Error("x"))).toBeNull();
  });

  it("does not read a known code with the wrong status as a refusal", async () => {
    hostFetch.mockResolvedValue(
      json({ detail: "odd" }, 500, "restore_window_closed"),
    );
    const error = await restoreHostShare(project, "tok").catch((e) => e);

    expect(restoreRefusal(error)).toBeNull();
  });

  it("refuses to manage links for a guest share without asking the host", async () => {
    const guest = shareProjectKey("tok");
    await expect(restoreHostShare(guest, "tok")).rejects.toThrow(
      "not available for shared guests",
    );
    await expect(restoreHostRoom(guest, "r1")).rejects.toThrow(
      "not available for shared guests",
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
