import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFetch = vi.hoisted(() => vi.fn());
vi.mock("./documentTransport", () => ({ hostFetch }));

import { ApiError } from "../utils/apiError";
import { loadSessionTakes } from "./sessionTakes";

beforeEach(() => hostFetch.mockReset());

describe("loadSessionTakes", () => {
  it("reads the takes of one session from the host", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ suggestion_id: "ss-1", takes: [] })),
    );
    const reply = await loadSessionTakes("/tmp/ep", "ss-1");
    expect(reply.suggestion_id).toBe("ss-1");
    const [url] = hostFetch.mock.calls[0];
    expect(url).toBe(
      "/api/session-suggestion/takes?path=%2Ftmp%2Fep&suggestion_id=ss-1",
    );
  });

  it("throws the server's refusal with its code", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Gone" }), {
        status: 404,
        headers: { "X-Sharecut-Error-Code": "session_suggestion_not_found" },
      }),
    );
    await expect(loadSessionTakes("/tmp/ep", "x")).rejects.toMatchObject({
      code: "session_suggestion_not_found",
    });
    await expect(loadSessionTakes("/tmp/ep", "x")).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("refuses a share key without asking the host", async () => {
    await expect(loadSessionTakes("share:abc", "ss-1")).rejects.toThrow(
      "Takes are only available to the host.",
    );
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
