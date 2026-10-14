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
    warmPendingPreview("/tmp/once.json", "cut");
    warmPendingPreview("/tmp/once.json", "cut");
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
    warmPendingPreview("/tmp/refused.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    warmPendingPreview("/tmp/refused.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(2));
  });

  it("asks again when a side did not render", async () => {
    open("/tmp/failed-side.json");
    vi.mocked(hostFetch).mockImplementationOnce(async () =>
      Response.json({ trim_db: -3, sides: { current: "failed" } }),
    );
    warmPendingPreview("/tmp/failed-side.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    warmPendingPreview("/tmp/failed-side.json", "cut");
    await vi.waitFor(() => expect(hostFetch).toHaveBeenCalledTimes(2));
  });

  it("never asks for a guest", () => {
    open("/tmp/guest.json");
    useDawStore.setState({ guestMode: "edit" });
    warmPendingPreview("/tmp/guest.json", "cut");
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
