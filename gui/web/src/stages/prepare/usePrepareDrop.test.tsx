import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ingestFiles } from "../../ingest/ingestFiles";
import { usePrepareDrop } from "./usePrepareDrop";

vi.mock("../../ingest/ingestFiles", () => ({ ingestFiles: vi.fn() }));

function drag(type: string, files: File[] = [], kinds: string[] = ["Files"]) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: kinds,
      items: files.map(() => ({ kind: "file" })),
      files,
      dropEffect: "none",
    },
  });
  return event;
}

const wav = new File(["x"], "a.wav", { type: "audio/wav" });
const txt = new File(["x"], "a.txt", { type: "text/plain" });

beforeEach(() => vi.clearAllMocks());

describe("usePrepareDrop", () => {
  it("shows the drop frame with the file count while files are held over the window", () => {
    const { result } = renderHook(() => usePrepareDrop(true));
    expect(result.current.active).toBe(false);
    act(() => void window.dispatchEvent(drag("dragenter", [wav, wav])));
    expect(result.current).toEqual({ active: true, count: 2 });
  });

  it("stays on while the drag crosses child elements and goes off when it leaves", () => {
    const { result } = renderHook(() => usePrepareDrop(true));
    act(() => void window.dispatchEvent(drag("dragenter", [wav])));
    act(() => void window.dispatchEvent(drag("dragenter", [wav])));
    act(() => void window.dispatchEvent(drag("dragleave", [wav])));
    expect(result.current.active).toBe(true);
    act(() => void window.dispatchEvent(drag("dragleave", [wav])));
    expect(result.current.active).toBe(false);
  });

  it("ignores a drag that is not files", () => {
    const { result } = renderHook(() => usePrepareDrop(true));
    act(() => void window.dispatchEvent(drag("dragenter", [], ["text/plain"])));
    expect(result.current.active).toBe(false);
  });

  it("adds the dropped audio as new tracks and skips other files", () => {
    renderHook(() => usePrepareDrop(true));
    const dropped = drag("drop", [wav, txt]);
    act(() => void window.dispatchEvent(dropped));
    expect(dropped.defaultPrevented).toBe(true);
    expect(ingestFiles).toHaveBeenCalledWith([wav], { kind: "new" });
  });

  it("does nothing when adding is not allowed", () => {
    const { result } = renderHook(() => usePrepareDrop(false));
    act(() => void window.dispatchEvent(drag("dragenter", [wav])));
    act(() => void window.dispatchEvent(drag("drop", [wav])));
    expect(result.current.active).toBe(false);
    expect(ingestFiles).not.toHaveBeenCalled();
  });
});
