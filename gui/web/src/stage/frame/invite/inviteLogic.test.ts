import { describe, expect, it } from "vitest";
import { shareRowsOf } from "../../../stages/deliver/shareLogic";
import { hostShareRow } from "../../../test/fixtures";
import type { TunnelStatus } from "../../../types/tunnel";
import { localOnlyNoteOf, roomIsLocalOnly } from "./inviteLogic";

const tunnel = (state: TunnelStatus["state"]): TunnelStatus => ({
  state,
  reason: null,
  reason_kind: null,
  relay_host: null,
  public_base_url: null,
  share_count: null,
  retry_at: null,
});

const room = (
  guest: Partial<Parameters<typeof hostShareRow>[0]>,
  producer: Partial<Parameters<typeof hostShareRow>[0]> = guest,
) => {
  const base = {
    kind: "record" as const,
    docs_role: null,
    session_id: "room-1",
  };
  const { rooms } = shareRowsOf([
    hostShareRow({ ...base, token: "g", record_role: "guest", ...guest }),
    hostShareRow({ ...base, token: "p", record_role: "producer", ...producer }),
  ]);
  return rooms[0] as NonNullable<(typeof rooms)[number]>;
};

const at = (url: string | null) => ({ url });

describe("roomIsLocalOnly", () => {
  it.each([
    ["loopback", "http://127.0.0.1:8080/rec/a", null, true],
    ["loopback, not set up", "http://127.0.0.1:8080/rec/a", "not_set_up", true],
    ["private 192.168", "http://192.168.1.20:8765/rec/a", null, true],
    ["a .local name", "http://studio.local:8765/rec/a", null, true],
    [
      "a public host, no tunnel",
      "https://share.example.app/rec/a",
      null,
      false,
    ],
    [
      "a public host, not set up",
      "https://share.example.app/rec/a",
      "not_set_up",
      false,
    ],
    ["a public host, off", "https://share.example.app/rec/a", "off", true],
    ["loopback, online", "http://127.0.0.1:8080/rec/a", "online", false],
    ["loopback, limited", "http://127.0.0.1:8080/rec/a", "limited", false],
    [
      "loopback, connecting",
      "http://127.0.0.1:8080/rec/a",
      "connecting",
      false,
    ],
    [
      "loopback, reconnecting",
      "http://127.0.0.1:8080/rec/a",
      "reconnecting",
      false,
    ],
    ["loopback, offline", "http://127.0.0.1:8080/rec/a", "offline", false],
  ] as const)("%s", (_name, url, state, expected) => {
    expect(roomIsLocalOnly(room(at(url)), state ? tunnel(state) : null)).toBe(
      expected,
    );
  });

  it("ignores rows without an address", () => {
    expect(roomIsLocalOnly(room(at(null)), null)).toBe(false);
  });

  it("ignores closed invites and counts the open one beside them", () => {
    const local = at("http://127.0.0.1:8080/rec/a");
    expect(
      roomIsLocalOnly(
        room(
          { ...local, invite_closed: true },
          { ...local, invite_closed: true },
        ),
        null,
      ),
    ).toBe(false);
    expect(
      roomIsLocalOnly(room({ ...local, invite_closed: true }, local), null),
    ).toBe(true);
  });

  it("is true when only the producer link is local", () => {
    expect(
      roomIsLocalOnly(
        room(
          at("https://share.example.app/rec/a"),
          at("http://127.0.0.1:8080/rec/b"),
        ),
        null,
      ),
    ).toBe(true);
  });
});

describe("localOnlyNoteOf", () => {
  it("says sharing is off when the tunnel is off", () => {
    expect(localOnlyNoteOf(tunnel("off"))).toMatch(
      /^Online sharing is off, so only people on this network/,
    );
  });

  it.each([null, undefined, tunnel("not_set_up")])(
    "says it is not set up when the tunnel is %j",
    (status) => {
      expect(localOnlyNoteOf(status)).toMatch(
        /^Online sharing isn't set up on this computer, so only people on this network/,
      );
    },
  );
});
