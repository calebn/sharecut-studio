import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostFetch } from "../api/documentTransport";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { warmPendingPreview } from "./pendingPreview";

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

describe("warmPendingPreview", () => {
  beforeEach(() => {
    vi.mocked(hostFetch)
      .mockReset()
      .mockImplementation(async () => new Response("{}"));
    useDawStore.setState({ guestMode: null });
  });

  function open(path: string) {
    useDawStore.getState().hydrate(path, minimalProject());
  }

  it("asks the host once per mix and not again", () => {
    open("/tmp/once.json");
    void warmPendingPreview("/tmp/once.json", "cut");
    void warmPendingPreview("/tmp/once.json", "cut");
    expect(hostFetch).toHaveBeenCalledTimes(1);
    expect(hostFetch).toHaveBeenCalledWith(
      `/api/pending-preview/warm?path=${encodeURIComponent("/tmp/once.json")}&edit_id=cut`,
      { method: "POST" },
    );
  });

  it("asks again after the host refused", async () => {
    open("/tmp/refused.json");
    vi.mocked(hostFetch).mockImplementationOnce(
      async () => new Response("no", { status: 500 }),
    );
    void warmPendingPreview("/tmp/refused.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    void warmPendingPreview("/tmp/refused.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(2));
  });

  it("asks again when a side did not render", async () => {
    open("/tmp/failed-side.json");
    vi.mocked(hostFetch).mockImplementationOnce(async () =>
      Response.json({ trim_db: -3, sides: { current: "failed" } }),
    );
    void warmPendingPreview("/tmp/failed-side.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    void warmPendingPreview("/tmp/failed-side.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(2));
  });

  it("asks for the mix alone, at a low priority, with no edit", async () => {
    open("/tmp/mixonly.json");
    await warmPendingPreview("/tmp/mixonly.json", null);
    expect(hostFetch).toHaveBeenCalledWith(
      `/api/pending-preview/warm?path=${encodeURIComponent("/tmp/mixonly.json")}&background=true`,
      { method: "POST" },
    );
  });

  it("reports a busy host as not done", async () => {
    open("/tmp/busy.json");
    vi.mocked(hostFetch).mockImplementationOnce(
      async () => new Response("busy", { status: 503 }),
    );
    expect(await warmPendingPreview("/tmp/busy.json", null)).toBe(false);
  });

  it("never asks for a guest", () => {
    open("/tmp/guest.json");
    useDawStore.setState({ guestMode: "edit" });
    void warmPendingPreview("/tmp/guest.json", "cut");
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
