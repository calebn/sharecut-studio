import { describe, expect, it, vi } from "vitest";
import { withDocumentCommandTypes } from "./transcriptEdit";

type FakeRequest = {
  method: () => string;
  url: () => string;
  postDataJSON: () => unknown;
};

function fakeRequest(method: string, url: string, body: unknown): FakeRequest {
  return {
    method: () => method,
    url: () => url,
    postDataJSON: () => body,
  };
}

function fakePage() {
  const listeners: Array<(req: FakeRequest) => void> = [];
  const on = vi.fn((_event: string, listener: (req: FakeRequest) => void) => {
    listeners.push(listener);
  });
  const off = vi.fn((_event: string, listener: (req: FakeRequest) => void) => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  });
  const emit = (req: FakeRequest) => {
    for (const listener of listeners) listener(req);
  };
  return { page: { on, off } as never, on, off, emit };
}

describe("withDocumentCommandTypes", () => {
  it("collects the type of a POST to /api/document/command", async () => {
    const { page, emit } = fakePage();
    const seen = await withDocumentCommandTypes(page, async (types) => {
      emit(
        fakeRequest("POST", "/api/document/command?path=%2Fp.json", {
          type: "CorrectTranscriptWord",
        }),
      );
      return [...types];
    });
    expect(seen).toEqual(["CorrectTranscriptWord"]);
  });

  it("ignores non-matching requests", async () => {
    const { page, emit } = fakePage();
    const seen = await withDocumentCommandTypes(page, async (types) => {
      emit(
        fakeRequest("GET", "/api/document/command?path=%2Fp.json", {
          type: "CorrectTranscriptWord",
        }),
      );
      emit(
        fakeRequest("POST", "/api/other", { type: "CorrectTranscriptWord" }),
      );
      emit(fakeRequest("POST", "/api/document/command?path=%2Fp.json", {}));
      emit(fakeRequest("POST", "/api/document/command?path=%2Fp.json", null));
      return [...types];
    });
    expect(seen).toEqual([]);
  });

  it("keeps the order types arrive in", async () => {
    const { page, emit } = fakePage();
    const seen = await withDocumentCommandTypes(page, async (types) => {
      emit(
        fakeRequest("POST", "/api/document/command?path=%2Fp.json", {
          type: "CorrectTranscriptWord",
        }),
      );
      emit(
        fakeRequest("POST", "/api/document/command?path=%2Fp.json", {
          type: "UndoHistory",
        }),
      );
      return [...types];
    });
    expect(seen).toEqual(["CorrectTranscriptWord", "UndoHistory"]);
  });

  it("detaches the same listener after body resolves", async () => {
    const { page, on, off } = fakePage();
    await withDocumentCommandTypes(page, async (types) => {
      expect(off).not.toHaveBeenCalled();
      return [...types];
    });
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    const [onEvent, onListener] = on.mock.calls[0]!;
    const [offEvent, offListener] = off.mock.calls[0]!;
    expect(onEvent).toBe("request");
    expect(offEvent).toBe("request");
    expect(offListener).toBe(onListener);
  });

  it("detaches and rethrows when body throws", async () => {
    const { page, on, off } = fakePage();
    await expect(
      withDocumentCommandTypes(page, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(off).toHaveBeenCalledTimes(1);
    expect(off.mock.calls[0]![1]).toBe(on.mock.calls[0]![1]);
  });

  it("returns body's result", async () => {
    const { page } = fakePage();
    await expect(withDocumentCommandTypes(page, async () => 42)).resolves.toBe(
      42,
    );
  });
});
