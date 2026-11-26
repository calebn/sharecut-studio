import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/segments";
import { deferred } from "../test/deferred";
import { ApiError } from "../utils/apiError";
import { SEGMENT_FILE, waiting } from "./fixtures";
import { useSegmentImport } from "./useSegmentImport";

vi.mock("../api/segments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/segments")>()),
  previewSegmentImport: vi.fn(),
  commitSegmentImport: vi.fn(),
  cancelSegmentImport: vi.fn(),
}));

const preview = vi.mocked(api.previewSegmentImport);
const commit = vi.mocked(api.commitSegmentImport);
const cancel = vi.mocked(api.cancelSegmentImport);
const onDone = vi.fn();

beforeEach(() => {
  preview.mockReset().mockResolvedValue(waiting());
  commit
    .mockReset()
    .mockResolvedValue({ status: "added", id: "cold-open-1", version: 1 });
  cancel.mockReset().mockResolvedValue(undefined);
  onDone.mockReset();
});

function setup() {
  return renderHook(() => useSegmentImport({ onDone }));
}

async function staged() {
  const view = setup();
  act(() => view.result.current.choose(SEGMENT_FILE()));
  await waitFor(() => expect(view.result.current.state.phase).toBe("preview"));
  return view;
}

describe("useSegmentImport", () => {
  it("starts idle and holds the file name while it uploads", async () => {
    const pending = deferred<api.SegmentImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result } = setup();
    expect(result.current.state).toEqual({ phase: "idle" });

    act(() => result.current.choose(SEGMENT_FILE()));
    expect(result.current.state).toEqual({
      phase: "uploading",
      fileName: "cold-open.sharecutseg",
    });
    await act(async () => pending.resolve(waiting()));
    expect(result.current.state).toEqual({
      phase: "preview",
      preview: waiting(),
      notice: null,
    });
  });

  it("shows the service's message for a bad file and keeps nothing staged", async () => {
    preview.mockRejectedValueOnce(
      new ApiError(
        "This file is not a segment bundle.",
        "segment_bundle_invalid",
        422,
      ),
    );
    const { result } = setup();
    act(() => result.current.choose(SEGMENT_FILE()));
    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state).toEqual({
      phase: "error",
      fileName: "cold-open.sharecutseg",
      message: "This file is not a segment bundle.",
    });
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("adds: committing, then idle, and tells the caller the id and what was added", async () => {
    const { result } = await staged();
    const pending = deferred<api.SegmentSaveResult>();
    commit.mockReturnValueOnce(pending.promise);

    act(() => result.current.add());
    expect(result.current.state.phase).toBe("committing");
    expect(commit).toHaveBeenCalledWith("a".repeat(32));
    await act(async () =>
      pending.resolve({ status: "added", id: "cold-open-1", version: 1 }),
    );

    expect(result.current.state).toEqual({ phase: "idle" });
    expect(onDone).toHaveBeenCalledWith(
      "cold-open-1",
      "Added Cold open to your library",
    );
  });

  it("reports what the commit did, which can differ from the preview", async () => {
    const { result } = await staged();
    commit.mockResolvedValueOnce({
      status: "unchanged",
      id: "other-1",
      version: 1,
    });
    act(() => result.current.add());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith(
      "other-1",
      "Cold open is already in your library",
    );
  });

  it("says a new version by number", async () => {
    preview.mockResolvedValueOnce(
      waiting({ outcome: "new_version", version: 2 }),
    );
    const { result } = await staged();
    commit.mockResolvedValueOnce({
      status: "new_version",
      id: "cold-open-1",
      version: 2,
    });
    act(() => result.current.add());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalledWith(
      "cold-open-1",
      "Added Cold open as version 2",
    );
  });

  it("does not commit a file that is already in the library: it cancels and shows the row", async () => {
    preview.mockResolvedValueOnce(
      waiting({ outcome: "unchanged", existing_id: "cold-open-1" }),
    );
    const { result } = await staged();
    act(() => result.current.add());
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("a".repeat(32));
    expect(result.current.state).toEqual({ phase: "idle" });
    expect(onDone).toHaveBeenCalledWith(
      "cold-open-1",
      "Cold open is already in your library",
    );
  });

  it("keeps the preview and says why when the library is busy, so Add can be tried again", async () => {
    const { result } = await staged();
    commit.mockRejectedValueOnce(
      new ApiError(
        "Another program is using the library.",
        "segment_busy",
        409,
      ),
    );
    act(() => result.current.add());
    await waitFor(() => expect(result.current.state.phase).toBe("preview"));
    expect(result.current.state).toMatchObject({
      notice: "Another program is using the library.",
    });
    act(() => result.current.add());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("ends in an error when the staged file is gone", async () => {
    const { result } = await staged();
    commit.mockRejectedValueOnce(
      new ApiError(
        "This import is no longer waiting. Choose the file again.",
        "segment_import_unknown",
        404,
      ),
    );
    act(() => result.current.add());
    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state).toMatchObject({
      message: "This import is no longer waiting. Choose the file again.",
    });
  });

  it("cancels the waiting file on Cancel", async () => {
    const { result } = await staged();
    act(() => result.current.cancel());
    expect(result.current.state).toEqual({ phase: "idle" });
    expect(cancel).toHaveBeenCalledWith("a".repeat(32));
  });

  it("aborts an upload on Cancel and ignores its late answer", async () => {
    const pending = deferred<api.SegmentImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result } = setup();
    act(() => result.current.choose(SEGMENT_FILE()));
    const signal = preview.mock.calls[0][1] as AbortSignal;

    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    expect(result.current.state).toEqual({ phase: "idle" });
    await act(async () => pending.resolve(waiting({ token: "b".repeat(32) })));

    expect(result.current.state).toEqual({ phase: "idle" });
    expect(cancel).toHaveBeenCalledWith("b".repeat(32));
  });

  it("replaces a waiting preview when a second file is chosen, cancelling the first", async () => {
    const { result } = await staged();
    preview.mockResolvedValueOnce(
      waiting({ token: "c".repeat(32), name: "Outro" }),
    );

    act(() => result.current.choose(SEGMENT_FILE()));
    expect(cancel).toHaveBeenCalledWith("a".repeat(32));
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        phase: "preview",
        preview: { name: "Outro" },
      }),
    );
  });

  it("ignores Cancel and a new file while a commit is in flight", async () => {
    const { result } = await staged();
    commit.mockReturnValueOnce(deferred<api.SegmentSaveResult>().promise);
    act(() => result.current.add());

    act(() => result.current.cancel());
    act(() => result.current.choose(SEGMENT_FILE()));

    expect(result.current.state.phase).toBe("committing");
    expect(cancel).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("cancels the waiting file and aborts when the screen goes away", async () => {
    const { unmount } = await staged();
    unmount();
    expect(cancel).toHaveBeenCalledWith("a".repeat(32));

    const pending = deferred<api.SegmentImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const second = setup();
    act(() => second.result.current.choose(SEGMENT_FILE()));
    const signal = preview.mock.calls[1][1] as AbortSignal;
    second.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("leaves the token alone when the screen goes away while it is being added", async () => {
    const { result, unmount } = await staged();
    commit.mockReturnValueOnce(deferred<api.SegmentSaveResult>().promise);
    act(() => result.current.add());
    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });
});
