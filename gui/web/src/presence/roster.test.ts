import { describe, expect, it } from "vitest";
import {
  applyPresenceDelta,
  EMPTY_ROSTER,
  mergeRosterClient,
  rosterFromList,
  sessionClientList,
} from "./roster";

describe("rosterFromList", () => {
  it("keys entries by client_id", () => {
    const roster = rosterFromList([
      { client_id: "a", role: "viewer" },
      { client_id: "b", role: "agent" },
    ]);
    expect(Object.keys(roster)).toEqual(["a", "b"]);
    expect(roster.a.role).toBe("viewer");
  });

  it("reuses a prev entry's identity when its value is unchanged", () => {
    const a = { client_id: "a", role: "viewer", label: "Ada" };
    const prev = rosterFromList([a]);
    const next = rosterFromList(
      [{ client_id: "a", role: "viewer", label: "Ada" }],
      prev,
    );
    expect(next.a).toBe(prev.a);
  });

  it("does not reuse identity when the value changed", () => {
    const prev = rosterFromList([
      { client_id: "a", role: "viewer", label: "Ada" },
    ]);
    const next = rosterFromList(
      [{ client_id: "a", role: "viewer", label: "Ada2" }],
      prev,
    );
    expect(next.a).not.toBe(prev.a);
  });

  it("defaults to EMPTY_ROSTER as the base", () => {
    expect(rosterFromList([])).toEqual({});
  });
});

describe("sessionClientList", () => {
  it("memoizes by roster object identity", () => {
    const roster = rosterFromList([{ client_id: "a", role: "viewer" }]);
    const first = sessionClientList(roster);
    const second = sessionClientList(roster);
    expect(first).toBe(second);
  });

  it("returns a fresh array for a new roster object", () => {
    const roster1 = rosterFromList([{ client_id: "a", role: "viewer" }]);
    const roster2 = rosterFromList(
      [{ client_id: "a", role: "viewer" }],
      roster1,
    );
    expect(sessionClientList(roster1)).not.toBe(sessionClientList(roster2));
  });

  it("returns [] for the empty roster", () => {
    expect(sessionClientList(EMPTY_ROSTER)).toEqual([]);
  });
});

describe("mergeRosterClient", () => {
  it("merges changed top-level keys onto the previous entry", () => {
    const prev = { client_id: "a", role: "viewer", label: "Old" };
    const merged = mergeRosterClient("a", prev, { label: "New" });
    expect(merged).toEqual({ client_id: "a", role: "viewer", label: "New" });
  });

  it("creates a bare stub for an unknown client", () => {
    const merged = mergeRosterClient("a", undefined, { label: "New" });
    expect(merged).toEqual({ client_id: "a", role: "viewer", label: "New" });
  });

  it("merges changed meta keys, keeping unrelated meta keys", () => {
    const prev = {
      client_id: "a",
      role: "viewer",
      meta: { display_name: "Ada", color_index: 2 },
    };
    const merged = mergeRosterClient("a", prev, {
      meta: { cursor: { t_sec: 1 } },
    });
    expect(merged.meta).toEqual({
      display_name: "Ada",
      color_index: 2,
      cursor: { t_sec: 1 },
    });
  });

  it("drops a meta key mapped to null", () => {
    const prev = {
      client_id: "a",
      role: "viewer",
      meta: { display_name: "Ada", cursor: { t_sec: 1 } },
    };
    const merged = mergeRosterClient("a", prev, { meta: { cursor: null } });
    expect(merged.meta).toEqual({ display_name: "Ada" });
  });

  it("never mutates the previous entry", () => {
    const prev = { client_id: "a", role: "viewer", label: "Old" };
    mergeRosterClient("a", prev, { label: "New" });
    expect(prev.label).toBe("Old");
  });
});

describe("applyPresenceDelta", () => {
  const roster = rosterFromList([
    { client_id: "a", role: "viewer", label: "Old" },
  ]);

  it("applies a delta at the equal (current) version", () => {
    const result = applyPresenceDelta(roster, 3, "a", { label: "New" }, 3);
    expect(result.outcome).toBe("applied");
    expect(result.version).toBe(3);
    expect(result.roster.a.label).toBe("New");
  });

  it("drops a delta at an older version", () => {
    const result = applyPresenceDelta(roster, 5, "a", { label: "New" }, 3);
    expect(result.outcome).toBe("stale");
    expect(result.roster).toBe(roster);
    expect(result.version).toBe(5);
  });

  it("requests a resync at a newer version", () => {
    const result = applyPresenceDelta(roster, 3, "a", { label: "New" }, 7);
    expect(result.outcome).toBe("resync");
    expect(result.roster).toBe(roster);
  });

  it("requests a resync for an unknown author client id, even at the equal version", () => {
    const result = applyPresenceDelta(roster, 3, "ghost", { label: "New" }, 3);
    expect(result.outcome).toBe("resync");
  });

  it("keeps every other entry's identity", () => {
    const two = rosterFromList([
      { client_id: "a", role: "viewer" },
      { client_id: "b", role: "viewer" },
    ]);
    const result = applyPresenceDelta(two, 1, "a", { label: "New" }, 1);
    expect(result.roster.b).toBe(two.b);
    expect(result.roster.a).not.toBe(two.a);
  });
});
