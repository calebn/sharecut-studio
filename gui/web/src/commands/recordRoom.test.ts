import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { minimalProject, recordSnapshot } from "../test/fixtures";
import type { HostShareRow } from "../types/shares";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const api = vi.hoisted(() => ({
  createRoom: vi.fn(),
  listShares: vi.fn(),
  loadState: vi.fn(),
  land: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    createHostRecordRoom: (...args: unknown[]) => api.createRoom(...args),
    listHostShares: (...args: unknown[]) => api.listShares(...args),
    loadHostRecordState: (...args: unknown[]) => api.loadState(...args),
    hostLandRecord: (...args: unknown[]) => api.land(...args),
  };
});

const room = recordSnapshot({
  session_id: "room1",
  state: "lobby",
  take_index: -1,
  start_blockers: [{ code: "no_guest" }],
});

const guestRow = (fields: Partial<HostShareRow>): HostShareRow => ({
  token: "guest-token",
  url: "https://example.test/rec/guest-token",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "room1",
  mcp_url: null,
  usable: true,
  invite_closed: false,
  ...fields,
});

describe("record room commands", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      recordPanelOpen: true,
      shareDialogOpen: false,
      statusAnnouncement: "",
    });
    useRecordHostStore.getState().setSnapshot(null);
    useRecordHostStore.getState().setTransportError(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a room in place, copies its guest link and shows the room", async () => {
    api.createRoom.mockResolvedValue({
      session_id: "room1",
      guest: guestRow({}),
      producer: guestRow({ record_role: "producer", token: "p" }),
    });
    api.loadState.mockResolvedValue(room);
    expect(await execute("record.createRoom")).toEqual({ status: "ok" });
    expect(api.createRoom).toHaveBeenCalledWith("/tmp/p.json");
    expect(writeText).toHaveBeenCalledWith(
      "https://example.test/rec/guest-token",
    );
    expect(useRecordHostStore.getState().snapshot?.session_id).toBe("room1");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Record room created and guest link copied",
    );
  });

  it("refuses to mint over an open room", async () => {
    useRecordHostStore.getState().setSnapshot(room);
    expect(await execute("record.createRoom")).toEqual({
      status: "disabled",
      reason: "A record room is already open. End it in Share first.",
    });
    expect(api.createRoom).not.toHaveBeenCalled();
  });

  it("copies the open room's guest link", async () => {
    useRecordHostStore.getState().setSnapshot(room);
    api.listShares.mockResolvedValue({
      public_origin: "https://example.test",
      shares: [
        guestRow({ session_id: "old-room", url: "https://example.test/old" }),
        guestRow({}),
      ],
    });
    expect(await execute("record.copyGuestLink")).toEqual({ status: "ok" });
    expect(writeText).toHaveBeenCalledWith(
      "https://example.test/rec/guest-token",
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("Guest link copied");
  });

  it("explains a closed guest invite instead of copying it", async () => {
    useRecordHostStore.getState().setSnapshot(room);
    api.listShares.mockResolvedValue({
      public_origin: "https://example.test",
      shares: [guestRow({ invite_closed: true })],
    });
    const result = await execute("record.copyGuestLink");
    expect(result.status).toBe("disabled");
    expect(writeText).not.toHaveBeenCalled();
    expect(useRecordHostStore.getState().transportError).toBe(
      "This room's guest link is closed. Replace the guest invite in Share.",
    );
  });

  it("refuses Land while a take is open", async () => {
    useRecordHostStore
      .getState()
      .setSnapshot({ ...room, state: "recording", take_index: 0 });
    expect(await execute("record.land")).toEqual({
      status: "disabled",
      reason: "Stop the take to land it on the timeline.",
    });
    expect(api.land).not.toHaveBeenCalled();
  });
});
