import { describe, expect, it, vi } from "vitest";
import { recordDocumentCommandTypes } from "./transcriptEdit";

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

describe("recordDocumentCommandTypes", () => {
  it("collects the type of a POST to /api/document/command", () => {
    const { page, emit } = fakePage();
    const { types } = recordDocumentCommandTypes(page);
    emit(
      fakeRequest("POST", "/api/document/command?path=%2Fp.json", {
        type: "CorrectTranscriptWord",
      }),
    );
    expect(types).toEqual(["CorrectTranscriptWord"]);
  });

  it("ignores non-matching requests", () => {
    const { page, emit } = fakePage();
    const { types } = recordDocumentCommandTypes(page);
    emit(
      fakeRequest("GET", "/api/document/command?path=%2Fp.json", {
        type: "CorrectTranscriptWord",
      }),
    );
    emit(fakeRequest("POST", "/api/other", { type: "CorrectTranscriptWord" }));
    emit(fakeRequest("POST", "/api/document/command?path=%2Fp.json", {}));
    emit(fakeRequest("POST", "/api/document/command?path=%2Fp.json", null));
    expect(types).toEqual([]);
  });

  it("keeps the order types arrive in", () => {
    const { page, emit } = fakePage();
    const { types } = recordDocumentCommandTypes(page);
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
    expect(types).toEqual(["CorrectTranscriptWord", "UndoHistory"]);
  });

  it("stop() detaches the same listener that was attached", () => {
    const { page, on, off } = fakePage();
    const { stop } = recordDocumentCommandTypes(page);
    stop();
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    const [onEvent, onListener] = on.mock.calls[0]!;
    const [offEvent, offListener] = off.mock.calls[0]!;
    expect(onEvent).toBe("request");
    expect(offEvent).toBe("request");
    expect(offListener).toBe(onListener);
  });
});
