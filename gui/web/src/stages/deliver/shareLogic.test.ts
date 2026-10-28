import { describe, expect, it } from "vitest";
import { hostShareRow } from "../../test/fixtures";
import type { TunnelState, TunnelStatus } from "../../types/tunnel";
import { ONLINE } from "./shareFixture";
import {
  formatWhen,
  groupRecordRooms,
  pendingKey,
  reviewMeta,
  shareCopyKey,
  shareReachOf,
  shareRoleLabel,
} from "./shareLogic";

const tunnel = (state: TunnelState): TunnelStatus => ({ ...ONLINE, state });

describe("shareReachOf", () => {
  it.each<[TunnelState, "anywhere" | "network"]>([
    ["online", "anywhere"],
    ["connecting", "anywhere"],
    ["reconnecting", "anywhere"],
    ["offline", "anywhere"],
    ["off", "network"],
    ["not_set_up", "network"],
  ])("%s reaches %s", (state, reach) => {
    expect(shareReachOf(tunnel(state))).toBe(reach);
  });

  it("says nothing while the state is unknown", () => {
    expect(shareReachOf(null)).toBeUndefined();
    expect(shareReachOf(undefined)).toBeUndefined();
  });
});

describe("reviewMeta", () => {
  const base = hostShareRow({ review_version_label: null });

  it("is empty for a link with nothing to say", () => {
    expect(reviewMeta(base)).toBe("");
  });

  it("says a link follows the latest or is frozen on a version", () => {
    expect(
      reviewMeta({
        ...base,
        review_version_label: "Mix 3",
        follow_latest: true,
      }),
    ).toBe("Follows latest: Mix 3");
    expect(
      reviewMeta({
        ...base,
        review_version_label: "Mix 3",
        follow_latest: false,
      }),
    ).toBe("Frozen on Mix 3");
  });

  it("joins the version, MCP, created, last opened and expiry in that order", () => {
    const row = {
      ...base,
      review_version_label: "Mix 3",
      mcp_url: "http://x/mcp",
      created_at: "2026-10-01T12:00:00Z",
      last_used_at: "2026-10-03T12:00:00Z",
      expires_at: "2026-12-01T12:00:00Z",
    };
    expect(reviewMeta(row)).toBe(
      [
        "Follows latest: Mix 3",
        "AI assistants allowed",
        `Created ${formatWhen(row.created_at)}`,
        `Last opened ${formatWhen(row.last_used_at)}`,
        `Expires ${formatWhen(row.expires_at)}`,
      ].join(" · "),
    );
  });

  it("leaves out Last opened when it is the creation time", () => {
    expect(
      reviewMeta({
        ...base,
        created_at: "2026-10-01T12:00:00Z",
        last_used_at: "2026-10-01T12:00:00Z",
      }),
    ).toBe(`Created ${formatWhen("2026-10-01T12:00:00Z")}`);
  });
});

describe("formatWhen", () => {
  it("is empty without a time and echoes one it cannot read", () => {
    expect(formatWhen(null)).toBe("");
    expect(formatWhen(undefined)).toBe("");
    expect(formatWhen("")).toBe("");
    expect(formatWhen("last week")).toBe("last week");
  });
});

describe("shareRoleLabel", () => {
  it("names the role, else the raw role, else Review", () => {
    expect(shareRoleLabel(hostShareRow({ docs_role: "editor" }))).toBe(
      "Editor",
    );
    expect(shareRoleLabel(hostShareRow({ docs_role: "auditor" }))).toBe(
      "auditor",
    );
    expect(shareRoleLabel(hostShareRow({ docs_role: null }))).toBe("Review");
  });
});

describe("groupRecordRooms", () => {
  const link = (token: string, role: "guest" | "producer", session?: string) =>
    hostShareRow({
      token,
      kind: "record",
      record_role: role,
      session_id: session,
    });

  it("groups guest and producer links by room, in first-seen order", () => {
    const rooms = groupRecordRooms([
      link("g1", "guest", "a"),
      link("g2", "guest", "b"),
      link("p1", "producer", "a"),
    ]);
    expect(
      rooms.map((r) => [
        r.sessionId,
        r.guests.map((x) => x.token),
        r.producers.map((x) => x.token),
      ]),
    ).toEqual([
      ["a", ["g1"], ["p1"]],
      ["b", ["g2"], []],
    ]);
  });

  it("keys a link with no session by its own token and treats other roles as guests", () => {
    const rooms = groupRecordRooms([
      link("lonely", "guest"),
      hostShareRow({ token: "plain", kind: "record", record_role: null }),
    ]);
    expect(rooms.map((r) => [r.sessionId, r.guests.length])).toEqual([
      ["lonely", 1],
      ["plain", 1],
    ]);
  });
});

describe("keys", () => {
  it("names a copy by kind and token", () => {
    expect(shareCopyKey("link", "abc")).toBe("link:abc");
    expect(shareCopyKey("mcp", "abc")).toBe("mcp:abc");
  });

  it("names the pending end by link or room", () => {
    expect(pendingKey({ kind: "link", token: "abc" })).toBe("link:abc");
    expect(pendingKey({ kind: "room", sessionId: "r1" })).toBe("room:r1");
  });
});
