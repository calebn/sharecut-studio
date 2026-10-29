import { describe, expect, it } from "vitest";
import { hostShareRow } from "../../test/fixtures";
import type { TunnelStatus } from "../../types/tunnel";
import { ApiError } from "../../utils/apiError";
import {
  corsWarning,
  createRecoveryOf,
  reachOf,
  reviewMeta,
  roleLabel,
  roleOf,
  SHARE_DEFAULTS,
  shareCopyKey,
  shareEndKey,
  shareRowsOf,
} from "./shareLogic";

const outsidePrivateBlock = ["172", "32", "0", "4"].join(".");

const tunnel = (state: TunnelStatus["state"]): TunnelStatus => ({
  state,
  reason: null,
  reason_kind: null,
  relay_host: null,
  public_base_url: null,
  share_count: null,
  retry_at: null,
});

describe("SHARE_DEFAULTS", () => {
  it("starts a link as a Commenter that follows the latest, without MCP", () => {
    expect(SHARE_DEFAULTS).toEqual({
      role: "commenter",
      withMcp: false,
      freeze: false,
    });
  });
});

describe("shareCopyKey and shareEndKey", () => {
  it("keeps a link and its MCP URL apart, and a link apart from a room", () => {
    expect(shareCopyKey("link", "a")).toBe("link:a");
    expect(shareCopyKey("mcp", "a")).toBe("mcp:a");
    expect(shareEndKey({ kind: "link", token: "a" })).not.toBe(
      shareEndKey({ kind: "room", sessionId: "a" }),
    );
  });
});

describe("roleLabel and roleOf", () => {
  it("names the three roles", () => {
    expect(roleLabel(hostShareRow({ docs_role: "viewer" }))).toBe("Viewer");
    expect(roleLabel(hostShareRow({ docs_role: "editor" }))).toBe("Editor");
    expect(roleOf(hostShareRow({ docs_role: "commenter" }))).toBe("commenter");
  });
  it("falls back for a role it does not know", () => {
    expect(roleLabel(hostShareRow({ docs_role: null }))).toBe("Review");
    expect(roleLabel(hostShareRow({ docs_role: "owner" }))).toBe("owner");
    expect(roleOf(hostShareRow({ docs_role: "owner" }))).toBe("viewer");
  });
});

describe("reviewMeta", () => {
  it("says Follows latest or Frozen, with the version", () => {
    expect(reviewMeta(hostShareRow({ follow_latest: true }))).toBe(
      "Follows latest: Share mix",
    );
    expect(reviewMeta(hostShareRow({ follow_latest: false }))).toBe(
      "Frozen on Share mix",
    );
  });
  it("adds the MCP, creation, last opened and expiry in order", () => {
    const meta = reviewMeta(
      hostShareRow({
        mcp_url: "http://x/mcp",
        created_at: "2026-09-01T10:00:00Z",
        last_used_at: "2026-09-05T12:00:00Z",
        expires_at: "2026-10-01T10:00:00Z",
      }),
    );
    const parts = meta.split(" · ");
    expect(parts[0]).toBe("Follows latest: Share mix");
    expect(parts[1]).toBe("AI assistants allowed");
    expect(parts[2]).toMatch(/^Created /);
    expect(parts[3]).toMatch(/^Last opened /);
    expect(parts[4]).toMatch(/^Expires /);
  });
  it("skips Last opened when the link was never opened after it was made", () => {
    expect(
      reviewMeta(
        hostShareRow({
          review_version_label: null,
          created_at: "2026-09-01T10:00:00Z",
          last_used_at: "2026-09-01T10:00:00Z",
        }),
      ),
    ).toMatch(/^Created [^·]+$/);
  });
  it("is empty with nothing to say", () => {
    expect(reviewMeta(hostShareRow({ review_version_label: null }))).toBe("");
  });
});

describe("shareRowsOf", () => {
  it("keeps usable rows only and splits review links from record rooms", () => {
    const review = hostShareRow({ token: "r1" });
    const gone = hostShareRow({ token: "r2", usable: false, revoked: true });
    const guest = hostShareRow({
      token: "g1",
      kind: "record",
      record_role: "guest",
      session_id: "s1",
    });
    const producer = hostShareRow({
      token: "p1",
      kind: "record",
      record_role: "producer",
      session_id: "s1",
    });
    const otherRoom = hostShareRow({
      token: "g2",
      kind: "record",
      record_role: "guest",
      session_id: "s2",
    });
    const out = shareRowsOf([review, gone, guest, producer, otherRoom]);
    expect(out.review.map((r) => r.token)).toEqual(["r1"]);
    expect(out.rooms.map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    expect(out.rooms[0].guests.map((r) => r.token)).toEqual(["g1"]);
    expect(out.rooms[0].producers.map((r) => r.token)).toEqual(["p1"]);
  });
  it("groups a record row with no session by its own token", () => {
    const out = shareRowsOf([
      hostShareRow({ token: "lone", kind: "record", session_id: null }),
    ]);
    expect(out.rooms[0].sessionId).toBe("lone");
  });
});

describe("reachOf", () => {
  it("is network only when online sharing is off, whatever the link says", () => {
    expect(reachOf(tunnel("online"), "http://127.0.0.1:8765/r/a")).toBe(
      "anywhere",
    );
    expect(reachOf(tunnel("off"), "https://share.example.test/r/a")).toBe(
      "network",
    );
  });
  it("adds no note while online sharing is connecting, reconnecting or offline", () => {
    for (const state of ["connecting", "reconnecting", "offline"] as const) {
      expect(reachOf(tunnel(state), "http://127.0.0.1:8765/r/a")).toBe(
        "anywhere",
      );
    }
  });
  it("reads the link's address when the tunnel is unknown, absent or not set up", () => {
    for (const status of [null, undefined, tunnel("not_set_up")]) {
      expect(reachOf(status, "http://127.0.0.1:8765/r/a")).toBe("network");
      expect(reachOf(status, "http://localhost:8765/r/a")).toBe("network");
      expect(reachOf(status, "http://192.168.1.20:8765/r/a")).toBe("network");
      expect(reachOf(status, "http://172.20.0.4:8765/r/a")).toBe("network");
      expect(reachOf(status, "http://studio.local:8765/r/a")).toBe("network");
      expect(reachOf(status, "https://share.example.test/r/a")).toBe(
        "anywhere",
      );
      expect(reachOf(status, `http://${outsidePrivateBlock}/r/a`)).toBe(
        "anywhere",
      );
    }
  });
  it("says anywhere for a row with no address", () => {
    expect(reachOf(null, null)).toBe("anywhere");
    expect(reachOf(null, "not a url")).toBe("anywhere");
  });
});

describe("createRecoveryOf", () => {
  it("pairs no_mix and stale_mix with Refresh mix and its own copy", () => {
    expect(createRecoveryOf(new ApiError("x", "no_mix", 409))).toEqual({
      kind: "refresh",
      message:
        "This project has no mix yet. Refresh the mix to create the link.",
    });
    expect(
      createRecoveryOf(new ApiError("premix.wav", "stale_mix", 409)),
    ).toEqual({
      kind: "refresh",
      message:
        "The mix preview is out of date. Refresh it before creating a review link.",
    });
  });
  it("sends stale_master to an export, not to Refresh mix", () => {
    expect(createRecoveryOf(new ApiError("x", "stale_master", 409))).toEqual({
      kind: "stale_master",
      message:
        "The mastered mix is out of date. Export a new master before creating a review link.",
    });
  });
  it("leaves any other error as an error", () => {
    expect(createRecoveryOf(new ApiError("x", "other", 500))).toEqual({
      kind: "error",
    });
    expect(createRecoveryOf(new ApiError("x", null, 500))).toEqual({
      kind: "error",
    });
    expect(createRecoveryOf(new Error("x"))).toEqual({ kind: "error" });
  });
});

describe("corsWarning", () => {
  it("names the origin the bucket has no CORS rule for", () => {
    const copy = corsWarning(
      hostShareRow({
        warnings: [
          {
            code: "object_store_cors",
            message: "m",
            origin: "https://sharecut.studio",
          },
        ],
      }),
    );
    expect(copy).toMatch(/no CORS rule for https:\/\/sharecut\.studio/);
    expect(copy).toMatch(/docs\/host-online-relay\.md/);
  });
  it("falls back to the share origin and ignores other warnings", () => {
    expect(
      corsWarning(
        hostShareRow({
          warnings: [{ code: "object_store_cors", message: "m" }],
        }),
      ),
    ).toMatch(/no CORS rule for the share origin/);
    expect(
      corsWarning(
        hostShareRow({ warnings: [{ code: "other", message: "m" }] }),
      ),
    ).toBeNull();
    expect(corsWarning(hostShareRow())).toBeNull();
  });
});
