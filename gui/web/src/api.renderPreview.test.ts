import { afterEach, describe, expect, it, vi } from "vitest";
import { startRenderPreview } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guest render preview", () => {
  it("polls the accepted job until it completes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { id: "job-1" } }), { status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { status: "ok", error: null } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(startRenderPreview("share:token-1")).resolves.toEqual({
      mode: "sync",
      ok: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/daw/render-preview");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/daw/render-preview/job-1");
  });

  it("reports terminal job failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ job: { id: "job-2" } }), {
            status: 202,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              job: { status: "error", error: "Render preview failed" },
            }),
          ),
        ),
    );
    await expect(startRenderPreview("share:token-1")).rejects.toThrow(
      "Render preview failed",
    );
  });
});
