import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostFetch } from "../api/documentTransport";
import { useDawStore } from "../state/dawStore";
import {
  minimalProject,
  sessionSuggestionView,
  wavResponse,
} from "../test/fixtures";
import {
  playSessionPreview,
  SESSION_PREVIEW_STALE_REASON,
  warmSessionPreview,
} from "./pendingPreview";

vi.mock("../api/documentTransport", () => ({ hostFetch: vi.fn() }));

const PATH = "/tmp/session-preview.json";

function open(suggested = true) {
  useDawStore.getState().hydrate(
    PATH,
    minimalProject({
      session_suggestions: suggested ? [sessionSuggestionView()] : [],
    }),
  );
}

describe("session pickup preview", () => {
  beforeEach(() => {
    vi.mocked(hostFetch)
      .mockReset()
      .mockImplementation(async () => wavResponse(1));
    useDawStore.setState({ guestMode: null });
    URL.createObjectURL = vi.fn(() => "blob:session");
    URL.revokeObjectURL = vi.fn();
  });

  it("asks the host for the suggested window with the take and pad, and starts a source preview", async () => {
    open();
    const out = await playSessionPreview(PATH, "ss-1", "suggested", {
      padSec: 4,
      takeIndex: 2,
    });
    expect(out).toEqual({ status: "ok" });
    const url = String(vi.mocked(hostFetch).mock.calls[0]?.[0]);
    expect(url).toContain("/api/session-suggestion/hear-wav?");
    expect(url).toContain("suggestion_id=ss-1");
    expect(url).toContain("mode=suggested");
    expect(url).toContain("pad_sec=4");
    expect(url).toContain("take_index=2");
  });

  it("refuses a session the project no longer lists, without a request", async () => {
    open(false);
    expect(await playSessionPreview(PATH, "ss-1", "current")).toEqual({
      status: "disabled",
      reason: SESSION_PREVIEW_STALE_REASON,
    });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("reports a refused render as a reason", async () => {
    open();
    vi.mocked(hostFetch).mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ detail: "No audio" }), { status: 409 }),
    );
    const out = await playSessionPreview(PATH, "ss-1", "current");
    expect(out.status).toBe("disabled");
  });

  it("warms once per mix and asks again after a failed side", async () => {
    open();
    vi.mocked(hostFetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ sides: { current: "failed" } })),
    );
    expect(await warmSessionPreview(PATH, "ss-1")).toBe(false);
    expect(await warmSessionPreview(PATH, "ss-1")).toBe(false);
    expect(hostFetch).toHaveBeenCalledTimes(2);
    vi.mocked(hostFetch).mockImplementation(
      async () => new Response(JSON.stringify({ sides: { current: "ready" } })),
    );
    expect(await warmSessionPreview(PATH, "ss-1")).toBe(true);
    expect(await warmSessionPreview(PATH, "ss-1")).toBe(true);
    expect(hostFetch).toHaveBeenCalledTimes(3);
  });
});
