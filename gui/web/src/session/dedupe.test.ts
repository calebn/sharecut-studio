import { describe, expect, it } from "vitest";
import type { SessionState } from "../types/session";
import {
  baselineFromSnapshot,
  shouldApplyRemote,
  shouldHandleWsMessage,
} from "./dedupe";

function snap(partial: Partial<SessionState>): SessionState {
  return {
    version: 3,
    server_seq: partial.server_seq ?? 0,
    origin: partial.origin ?? "viewer",
    last_role: partial.last_role,
    last_client_id: partial.last_client_id,
    updated_at_ns: 0,
    last_command_id: partial.last_command_id ?? null,
    playhead_sec: partial.playhead_sec ?? 0,
    is_playing: partial.is_playing ?? false,
    audition_mode: partial.audition_mode ?? "mix",
    region: partial.region ?? null,
    source: null,
    track_id: null,
    query: null,
    match_index: null,
    selection: null,
    viewer_mute: {},
    solo_tracks: {},
    tier: null,
    dry_run: false,
  };
}

describe("baselineFromSnapshot", () => {
  it("applies agent transport before marking command_id", () => {
    const state = snap({
      server_seq: 5,
      origin: "agent",
      last_command_id: "cmd-a",
      region: { start_sec: 1, end_sec: 2 },
      playhead_sec: 1,
    });
    const { apply, next } = baselineFromSnapshot(state, {
      serverSeq: 0,
      commandId: null,
    });
    expect(apply).toBe(true);
    expect(next).toEqual({ serverSeq: 5, commandId: "cmd-a" });
  });

  it("does not apply viewer-only first snapshot", () => {
    const { apply } = baselineFromSnapshot(
      snap({ server_seq: 2, origin: "viewer", last_command_id: "v1" }),
      { serverSeq: 0, commandId: null },
    );
    expect(apply).toBe(false);
  });
});

describe("shouldApplyRemote", () => {
  it("dedupes same command_id", () => {
    const { apply } = shouldApplyRemote(
      snap({ server_seq: 6, last_command_id: "same", origin: "agent" }),
      { serverSeq: 5, commandId: "same" },
    );
    expect(apply).toBe(false);
  });

  it("applies agent seek", () => {
    const { apply } = shouldApplyRemote(
      snap({
        server_seq: 8,
        last_command_id: "seek",
        origin: "agent",
        playhead_sec: 42,
      }),
      { serverSeq: 7, commandId: "prev" },
    );
    expect(apply).toBe(true);
  });

  it("ignores own client echoes", () => {
    const { apply, next } = shouldApplyRemote(
      snap({
        server_seq: 10,
        last_command_id: "mine",
        origin: "viewer",
        last_client_id: "viewer-abc",
        is_playing: false,
      }),
      { serverSeq: 9, commandId: "prev" },
      {
        commandType: "SetPlaying",
        localClientId: "viewer-abc",
        localPlaying: true,
      },
    );
    expect(apply).toBe(false);
    expect(next.serverSeq).toBe(10);
  });

  it("ignores other viewers SetPlaying", () => {
    const { apply } = shouldApplyRemote(
      snap({
        server_seq: 11,
        last_command_id: "other",
        origin: "viewer",
        last_client_id: "viewer-other",
        is_playing: false,
      }),
      { serverSeq: 10, commandId: "prev" },
      {
        commandType: "SetPlaying",
        localClientId: "viewer-me",
        localPlaying: true,
      },
    );
    expect(apply).toBe(false);
  });

  it("applies other viewers SetSelection", () => {
    const { apply } = shouldApplyRemote(
      snap({
        server_seq: 12,
        last_command_id: "sel",
        origin: "viewer",
        last_client_id: "viewer-other",
      }),
      { serverSeq: 11, commandId: "prev" },
      {
        commandType: "SetSelection",
        localClientId: "viewer-me",
      },
    );
    expect(apply).toBe(true);
  });

  it("ignores polled snapshots while local playing", () => {
    const { apply } = shouldApplyRemote(
      snap({
        server_seq: 12,
        last_command_id: "v2",
        origin: "viewer",
        is_playing: false,
      }),
      { serverSeq: 11, commandId: "v1" },
      { localPlaying: true, localClientId: "viewer-me" },
    );
    expect(apply).toBe(false);
  });
});

describe("shouldHandleWsMessage", () => {
  it("handles agent Applied", () => {
    expect(
      shouldHandleWsMessage(
        {
          type: "Applied",
          command: { role: "agent", client_id: "agent-control" },
          snapshot: snap({ server_seq: 3, origin: "agent" }),
        },
        { serverSeq: 2, commandId: null },
      ),
    ).toBe(true);
  });

  it("ignores own SetPlaying echo", () => {
    expect(
      shouldHandleWsMessage(
        {
          type: "Applied",
          command: {
            role: "viewer",
            type: "SetPlaying",
            client_id: "viewer-me",
          },
          snapshot: snap({ server_seq: 6, origin: "viewer" }),
        },
        { serverSeq: 5, commandId: null },
        { localClientId: "viewer-me", localPlaying: true },
      ),
    ).toBe(false);
  });

  it("ignores other viewer SetPlaying", () => {
    expect(
      shouldHandleWsMessage(
        {
          type: "Applied",
          command: {
            role: "viewer",
            type: "SetPlaying",
            client_id: "viewer-other",
          },
          snapshot: snap({ server_seq: 6, origin: "viewer" }),
        },
        { serverSeq: 5, commandId: null },
        { localClientId: "viewer-me", localPlaying: true },
      ),
    ).toBe(false);
  });
});
