import { describe, expect, it } from "vitest";
import type { SessionState } from "../types/session";
import {
  mergeSessionAppliedDelta,
  sessionAppliedHasGap,
  withAgentAppliedAuthority,
} from "./appliedDelta";

const base = {
  server_seq: 4,
  last_command_id: "cmd-4",
  playhead_sec: 10,
  is_playing: true,
  clients: [{ client_id: "old", role: "viewer" }],
  roster_version: 4,
} as SessionState;

describe("session Applied deltas", () => {
  it("merges sparse patches without clearing unchanged transport fields", () => {
    expect(
      mergeSessionAppliedDelta(base, {
        server_seq: 5,
        last_command_id: "cmd-5",
        playhead_sec: 12,
      }),
    ).toMatchObject({
      server_seq: 5,
      last_command_id: "cmd-5",
      playhead_sec: 12,
      is_playing: true,
    });
    const merged = mergeSessionAppliedDelta(base, {
      server_seq: 5,
      last_command_id: "cmd-5",
      playhead_sec: 12,
    });
    expect(merged).not.toHaveProperty("clients");
    expect(merged).not.toHaveProperty("roster_version");
  });

  it("keeps collapsed agent authority when a full resync reads a viewer head", () => {
    expect(
      withAgentAppliedAuthority(
        {
          ...base,
          server_seq: 8,
          last_command_id: "viewer-8",
          last_client_id: "viewer",
          origin: "viewer",
          last_role: "viewer",
        },
        { last_command_id: "agent-7", last_client_id: "agent" },
        { client_id: "agent", command_id: "agent-7" },
      ),
    ).toMatchObject({
      server_seq: 8,
      last_command_id: "agent-7",
      last_client_id: "agent",
      origin: "agent",
      last_role: "agent",
    });
  });

  it("flags one sequence gap and accepts the next contiguous frame", () => {
    expect(sessionAppliedHasGap(4, 4, 5)).toBe(false);
    expect(sessionAppliedHasGap(4, 3, 5)).toBe(true);
    expect(sessionAppliedHasGap(4, undefined, 5)).toBe(true);
    expect(sessionAppliedHasGap(5, 3, 5)).toBe(false);
    expect(sessionAppliedHasGap(null, 0, 1)).toBe(true);
  });
});
