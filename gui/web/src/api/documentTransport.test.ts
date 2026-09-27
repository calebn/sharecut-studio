import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_COMMAND_TIMEOUT_MS,
  postGuestDocumentCommand,
  postHostDocumentCommand,
} from "./documentTransport";

describe("postHostDocumentCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a POST that does not answer in time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ),
    );
    const pending = postHostDocumentCommand("/tmp/episode.project.json", {});
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(DOCUMENT_COMMAND_TIMEOUT_MS);
    await assertion;
  });

  it("clears its timer once the server answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await postHostDocumentCommand("/tmp/episode.project.json", {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a guest POST that does not answer in time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ),
    );
    const pending = postGuestDocumentCommand("tok", {});
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(DOCUMENT_COMMAND_TIMEOUT_MS);
    await assertion;
  });

  it("aborts when headers arrive but the body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () =>
                  controller.error(init.signal?.reason),
                );
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const pending = postHostDocumentCommand("/tmp/episode.project.json", {});
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(DOCUMENT_COMMAND_TIMEOUT_MS);
    await assertion;
  });

  it("returns a refused command's typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Refine required" }), {
            status: 409,
            headers: { "X-Sharecut-Error-Code": "transcript_refine_required" },
          }),
      ),
    );
    await expect(
      postHostDocumentCommand("/tmp/episode.project.json", {}),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      failure: {
        code: "transcript_refine_required",
        message: "Refine required",
      },
    });
  });

  it("returns the parsed body of an accepted command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, server_seq: 3 }), {
            status: 200,
          }),
      ),
    );
    await expect(
      postHostDocumentCommand("/tmp/episode.project.json", {}),
    ).resolves.toEqual({ ok: true, data: { ok: true, server_seq: 3 } });
  });
});
