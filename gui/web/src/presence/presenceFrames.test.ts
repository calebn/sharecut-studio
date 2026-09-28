import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rosterFromList } from "../presence/roster";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionClient } from "../test/fixtures";
import {
  applyPresenceFrame,
  handlePresenceWsFrame,
  isPresenceOnlyFrame,
} from "./presenceFrames";

describe("PresenceResync", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });

  it("applyPresenceFrame requests a resync", () => {
    expect(applyPresenceFrame({ type: "PresenceResync" })).toBe(true);
  });

  it("isPresenceOnlyFrame is true for PresenceResync", () => {
    expect(isPresenceOnlyFrame({ type: "PresenceResync" })).toBe(true);
  });
});

describe("applyPresenceFrame: out-of-band Presence ordering", () => {
  const a = sessionClient({ client_id: "a" });
  const b = sessionClient({ client_id: "b" });

  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      sessionClients: rosterFromList([a, b]),
      sessionRosterVersion: 5,
    });
  });

  afterEach(() => {
    useDawStore.setState({ sessionRosterVersion: 0 });
  });

  it("drops a full Presence older than the local roster version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 4 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(5);
    expect(Object.keys(state.sessionClients).sort()).toEqual(["a", "b"]);
  });

  it("applies a full Presence at the equal version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 5 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(5);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("applies a full Presence at a newer version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a], roster_version: 6 });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(6);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("applies a full Presence with no roster_version", () => {
    applyPresenceFrame({ type: "Presence", clients: [a] });
    const state = useDawStore.getState();
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });

  it("a hello Snapshot always resets the version, even if older", () => {
    applyPresenceFrame({
      type: "Snapshot",
      snapshot: { clients: [a], roster_version: 1 } as never,
    });
    const state = useDawStore.getState();
    expect(state.sessionRosterVersion).toBe(1);
    expect(Object.keys(state.sessionClients)).toEqual(["a"]);
  });
});

describe("handlePresenceWsFrame", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      sessionClients: rosterFromList([sessionClient({ client_id: "a" })]),
      sessionRosterVersion: 1,
    });
  });

  const rosterRequester = () => ({
    request: vi.fn(),
    onRosterReceived: vi.fn(),
    dispose: vi.fn(),
  });

  it("a full Presence settles the outstanding request and returns true", () => {
    const rr = rosterRequester();
    const result = handlePresenceWsFrame(
      {
        type: "Presence",
        clients: [sessionClient({ client_id: "a" })],
        roster_version: 1,
      },
      rr,
    );
    expect(result).toBe(true);
    expect(rr.onRosterReceived).toHaveBeenCalledOnce();
    expect(rr.request).not.toHaveBeenCalled();
  });

  it("a version-gap PresenceDelta requests a resync and returns true", () => {
    const rr = rosterRequester();
    const result = handlePresenceWsFrame(
      {
        type: "PresenceDelta",
        author_client_id: "a",
        changes: { last_seen_ns: 1 },
        roster_version: 9,
      },
      rr,
    );
    expect(result).toBe(true);
    expect(rr.request).toHaveBeenCalledOnce();
    expect(rr.onRosterReceived).not.toHaveBeenCalled();
  });

  it("a PresenceResync requests a resync", () => {
    const rr = rosterRequester();
    const result = handlePresenceWsFrame({ type: "PresenceResync" }, rr);
    expect(result).toBe(true);
    expect(rr.request).toHaveBeenCalledOnce();
  });

  it("an Applied without clients returns false and calls neither", () => {
    const rr = rosterRequester();
    const result = handlePresenceWsFrame({ type: "Applied" }, rr);
    expect(result).toBe(false);
    expect(rr.request).not.toHaveBeenCalled();
    expect(rr.onRosterReceived).not.toHaveBeenCalled();
  });
});
