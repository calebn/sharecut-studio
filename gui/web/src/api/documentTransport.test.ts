import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_COMMAND_TIMEOUT_MS,
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
    await vi.advanceTimersByTimeAsync(HOST_COMMAND_TIMEOUT_MS);
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
});
