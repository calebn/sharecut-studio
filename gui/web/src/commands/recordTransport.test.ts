import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../record/hostStore";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const submit = vi.hoisted(() => vi.fn());
const land = vi.hoisted(() => vi.fn());

vi.mock("../record/hostTransport", () => ({
  submitHostRecordTransport: (...args: unknown[]) => submit(...args),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, hostLandRecord: (...args: unknown[]) => land(...args) };
});

const TRANSPORT_COMMANDS = [
  ["record.start", "Start"],
  ["record.pause", "Pause"],
  ["record.resume", "Resume"],
  ["record.stop", "Stop"],
] as const;

describe("record transport command failures", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    submit.mockReset();
    land.mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      recordPanelOpen: false,
      shareDialogOpen: false,
      statusAnnouncement: "",
    });
    useRecordHostStore.getState().setTransportError(null);
  });

  afterEach(() => {
    useRecordHostStore.getState().setTransportError(null);
  });

  it.each(TRANSPORT_COMMANDS)(
    "%s failure sets the error, opens the panel and announces",
    async (id, type) => {
      submit.mockRejectedValue(new Error("Room is not ready"));
      const result = await execute(id);
      expect(result.status).toBe("disabled");
      expect(submit).toHaveBeenCalledWith(type);
      expect(useRecordHostStore.getState().transportError).toBe(
        "Room is not ready",
      );
      expect(useDawStore.getState().recordPanelOpen).toBe(true);
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Room is not ready",
      );
    },
  );

  it("clears a previous error on success", async () => {
    useRecordHostStore.getState().setTransportError("old");
    submit.mockResolvedValue(undefined);
    expect(await execute("record.start")).toEqual({ status: "ok" });
    expect(useRecordHostStore.getState().transportError).toBeNull();
    expect(useDawStore.getState().recordPanelOpen).toBe(false);
  });

  it("only announces a failure over the Share dialog", async () => {
    useDawStore.setState({ shareDialogOpen: true });
    submit.mockRejectedValue(new Error("nope"));
    await execute("record.stop");
    expect(useDawStore.getState().statusAnnouncement).toBe("nope");
    expect(useRecordHostStore.getState().transportError).toBeNull();
    expect(useDawStore.getState().recordPanelOpen).toBe(false);
  });

  it("shows a failure in the open panel without a second announcement", async () => {
    useDawStore.setState({ recordPanelOpen: true });
    submit.mockRejectedValue(new Error("nope"));
    await execute("record.pause");
    expect(useRecordHostStore.getState().transportError).toBe("nope");
    expect(useDawStore.getState().recordPanelOpen).toBe(true);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("keeps a land failure visible", async () => {
    land.mockRejectedValue(new Error("Land failed"));
    const result = await execute("record.land");
    expect(result.status).toBe("disabled");
    expect(useRecordHostStore.getState().transportError).toBe("Land failed");
    expect(useDawStore.getState().recordPanelOpen).toBe(true);
  });
});
