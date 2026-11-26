import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/kits";
import { deferred } from "../test/deferred";
import { ApiError } from "../utils/apiError";
import {
  importEntry,
  KIT_FILE,
  KIT_TOKEN,
  UNCHANGED_KIT,
  waitingKit,
} from "./fixtures";
import { markLanded } from "./importMessages";
import { useKitImport } from "./useKitImport";

vi.mock("../api/kits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/kits")>()),
  previewKitImport: vi.fn(),
  commitKitImport: vi.fn(),
  cancelKitImport: vi.fn(),
}));

const preview = vi.mocked(api.previewKitImport);
const commit = vi.mocked(api.commitKitImport);
const cancel = vi.mocked(api.cancelKitImport);
const onChanged = vi.fn();
const onDone = vi.fn();

const result = (statuses: api.KitImportResult["segments"] = []) => ({
  kit: { status: "added" as const, id: "show-kit-1a2b3c4d", version: 1 },
  segments: statuses,
});

function partial(code: string, status: number, added: number, total: number) {
  return new ApiError(`Detail for ${code}.`, code, status, null, {
    detail: `Detail for ${code}.`,
    segments_added: Array.from({ length: added }, (_, i) => ({
      status: "added",
      id: `seg-${i}`,
      version: 1,
    })),
    segments_total: total,
  });
}

beforeEach(() => {
  preview.mockReset().mockResolvedValue(waitingKit());
  commit.mockReset().mockResolvedValue(result());
  cancel.mockReset().mockResolvedValue(undefined);
  onChanged.mockReset();
  onDone.mockReset();
});

async function staged(over = waitingKit()) {
  preview.mockResolvedValue(over);
  const view = renderHook(() => useKitImport({ onChanged, onDone }));
  act(() => view.result.current.choose(KIT_FILE()));
  await waitFor(() => expect(view.result.current.state.phase).toBe("preview"));
  return view;
}

describe("useKitImport", () => {
  it("holds the file name while it uploads, then the preview", async () => {
    const pending = deferred<api.KitImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    expect(hook.current.state).toEqual({ phase: "idle" });
    act(() => hook.current.choose(KIT_FILE()));
    expect(hook.current.state).toEqual({
      phase: "uploading",
      fileName: "show-kit.sharecutkit",
    });
    await act(async () => pending.resolve(waitingKit()));
    expect(hook.current.state).toEqual({
      phase: "preview",
      preview: waitingKit(),
      notice: null,
    });
  });

  it("shows the service's message for a refused file and stages nothing", async () => {
    preview.mockRejectedValueOnce(
      new ApiError("This is not a kit file.", "kit_bundle_invalid", 422),
    );
    const { result: hook } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    act(() => hook.current.choose(KIT_FILE()));
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(hook.current.state).toEqual({
      phase: "error",
      fileName: "show-kit.sharecutkit",
      message: "This is not a kit file.",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("commits by token, says what went in and asks for both lists to be read again", async () => {
    commit.mockResolvedValue(
      result([
        { status: "added", id: "intro-1", version: 1 },
        { status: "unchanged", id: "outro-1", version: 1 },
      ]),
    );
    const { result: hook } = await staged();
    act(() => hook.current.add());
    expect(hook.current.state.phase).toBe("committing");
    await waitFor(() => expect(hook.current.state.phase).toBe("idle"));
    expect(commit).toHaveBeenCalledWith(KIT_TOKEN);
    expect(onDone).toHaveBeenCalledWith(
      "Added Show Kit to your library, with 1 new segment",
      "intro-1",
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it("names a new version and an unchanged kit", async () => {
    commit.mockResolvedValueOnce({
      kit: { status: "new_version", id: "k", version: 3 },
      segments: [],
    });
    const first = await staged(
      waitingKit({ outcome: "new_version", version: 3 }),
    );
    act(() => first.result.current.add());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone).toHaveBeenLastCalledWith(
      "Added Show Kit as version 3",
      null,
    );

    commit.mockResolvedValueOnce({
      kit: { status: "unchanged", id: "k", version: 1 },
      segments: [
        { status: "new_version", id: "s", version: 2 },
        { status: "added", id: "t", version: 1 },
      ],
    });
    const second = await staged();
    act(() => second.result.current.add());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(2));
    expect(onDone).toHaveBeenLastCalledWith(
      "Show Kit is already in your library, with 2 new segments",
      "s",
    );
  });

  it("cancels the staged file when it is closed and when it unmounts", async () => {
    const closed = await staged();
    act(() => closed.result.current.cancel());
    expect(closed.result.current.state.phase).toBe("idle");
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);

    cancel.mockClear();
    const open = await staged();
    open.unmount();
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);
  });

  it("aborts an upload that is still running and drops a late preview", async () => {
    const pending = deferred<api.KitImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    act(() => hook.current.choose(KIT_FILE()));
    const signal = preview.mock.calls[0][1] as AbortSignal;
    act(() => hook.current.cancel());
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(waitingKit()));
    expect(hook.current.state.phase).toBe("idle");
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);
  });

  it("goes to the error phase when the file expired", async () => {
    commit.mockRejectedValueOnce(
      new ApiError("Unknown.", "kit_import_unknown", 404),
    );
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(hook.current.state).toMatchObject({
      message: "That file expired. Choose it again.",
    });
  });

  it.each(["kit_busy", "kit_no_room", "kit_write_failed"])(
    "keeps the file after %s and Add again commits the same token",
    async (code) => {
      commit.mockRejectedValueOnce(
        new ApiError(
          `Detail for ${code}.`,
          code,
          code === "kit_busy" ? 409 : 500,
        ),
      );
      const { result: hook } = await staged();
      act(() => hook.current.add());
      await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
      expect(hook.current.state).toMatchObject({
        notice: `Detail for ${code}.`,
      });
      expect(cancel).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();

      act(() => hook.current.add());
      await waitFor(() => expect(hook.current.state.phase).toBe("idle"));
      expect(commit).toHaveBeenCalledTimes(2);
      expect(commit.mock.calls.map((call) => call[0])).toEqual([
        KIT_TOKEN,
        KIT_TOKEN,
      ]);
      expect(onDone).toHaveBeenCalledTimes(1);
    },
  );

  it("sums the segments added across retries against the total and reads both lists after each", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 1, 3))
      .mockRejectedValueOnce(partial("kit_write_failed", 500, 1, 3));
    const { result: hook } = await staged();

    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(hook.current.state).toMatchObject({
      notice:
        "Detail for kit_busy. Added 1 of 3 segments. Choose Add to library to finish.",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    act(() => hook.current.add());
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({
        notice:
          "Detail for kit_write_failed. Added 2 of 3 segments. Choose Add to library to finish.",
      }),
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("makes no partial claim when nothing landed", async () => {
    commit.mockRejectedValueOnce(partial("kit_busy", 409, 0, 3));
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(hook.current.state).toMatchObject({
      notice: "Detail for kit_busy.",
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reads the lists and says what landed when a refusal that drops the file followed adds", async () => {
    commit.mockRejectedValueOnce(partial("kit_invalid", 422, 2, 3));
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(hook.current.state).toMatchObject({
      message:
        "Detail for kit_invalid. 2 segments were added to your library first.",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("starts the count again for a new file", async () => {
    commit.mockRejectedValueOnce(partial("kit_busy", 409, 2, 3));
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.cancel());

    commit.mockRejectedValueOnce(
      new ApiError("Detail for kit_busy.", "kit_busy", 409),
    );
    act(() => hook.current.choose(KIT_FILE()));
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({
        notice: "Detail for kit_busy.",
      }),
    );
  });

  it("ignores a second file while adding", async () => {
    const pending = deferred<api.KitImportResult>();
    commit.mockReturnValueOnce(pending.promise);
    const { result: hook } = await staged();
    act(() => hook.current.add());
    act(() => hook.current.choose(KIT_FILE()));
    act(() => hook.current.cancel());
    expect(hook.current.state.phase).toBe("committing");
    expect(preview).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(result()));
  });

  it("closes an entirely unchanged kit without a commit, dropping the staged file", async () => {
    const { result: hook } = await staged(UNCHANGED_KIT);
    act(() => hook.current.add());
    expect(hook.current.state.phase).toBe("idle");
    expect(commit).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);
    expect(onDone).toHaveBeenCalledWith(
      "Show Kit is already in your library",
      null,
    );
  });
});

const abortError = () =>
  new DOMException("The operation was aborted.", "AbortError");

describe("useKitImport after the first try", () => {
  it("says how many segments are already in the library when the file expired", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 2, 5))
      .mockRejectedValueOnce(
        new ApiError("Unknown.", "kit_import_unknown", 404),
      );
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(hook.current.state).toMatchObject({
      message:
        "That file expired. Choose it again. 2 of 5 segments are already in your library.",
    });
  });

  it("counts the segments added across every try in the success message", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 2, 3))
      .mockResolvedValueOnce(
        result([
          { status: "added", id: "late", version: 1 },
          { status: "unchanged", id: "a", version: 1 },
        ]),
      );
    const { result: hook } = await staged(waitingKit({ entry_count: 3 }));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("idle"));
    expect(onDone).toHaveBeenCalledWith(
      "Added Show Kit to your library, with 3 new segments",
      "late",
    );
  });

  it("says how many of the kit's segments are new when some were already there", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 1, 3))
      .mockResolvedValueOnce(
        result([{ status: "added", id: "late", version: 1 }]),
      );
    const { result: hook } = await staged(waitingKit({ entry_count: 3 }));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("idle"));
    expect(onDone).toHaveBeenCalledWith(
      "Added Show Kit to your library, with 2 of 3 segments new",
      "late",
    );
  });

  it("keeps the preview with a retryable notice when the commit had no server code", async () => {
    commit.mockRejectedValueOnce(
      new ApiError(
        "Couldn't reach the server. Check your connection and try again.",
        "network_error",
      ),
    );
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(hook.current.state).toMatchObject({
      notice: "Couldn't reach the server. Check your connection and try again.",
    });
    expect(cancel).not.toHaveBeenCalled();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("idle"));
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("cancels the staged file when it gives up on a refusal", async () => {
    commit.mockRejectedValueOnce(partial("kit_invalid", 422, 0, 2));
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);
  });

  it("does not turn a cancelled upload into an error sheet", async () => {
    const pending = deferred<api.KitImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result: hook } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    act(() => hook.current.choose(KIT_FILE()));
    act(() => hook.current.cancel());
    await act(async () => pending.reject(abortError()));
    expect(hook.current.state.phase).toBe("idle");
  });

  it("sends one commit for a double Add and ignores Add outside a preview", async () => {
    const pending = deferred<api.KitImportResult>();
    commit.mockReturnValueOnce(pending.promise);
    const { result: hook } = await staged();
    act(() => {
      hook.current.add();
      hook.current.add();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(result()));
    expect(hook.current.state.phase).toBe("idle");
    act(() => hook.current.add());
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("takes another file from the error sheet", async () => {
    preview.mockRejectedValueOnce(
      new ApiError("Not a kit.", "kit_bundle_invalid", 422),
    );
    const { result: hook } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    act(() => hook.current.choose(KIT_FILE()));
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    act(() => hook.current.choose(KIT_FILE()));
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("starts no upload for a file chosen after it unmounted", () => {
    const { result: hook, unmount } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    unmount();
    act(() => hook.current.choose(KIT_FILE()));
    expect(preview).not.toHaveBeenCalled();
  });

  it("aborts an upload in flight at unmount and cancels the token that still arrives", async () => {
    const pending = deferred<api.KitImportPreview>();
    preview.mockReturnValueOnce(pending.promise);
    const { result: hook, unmount } = renderHook(() =>
      useKitImport({ onChanged, onDone }),
    );
    act(() => hook.current.choose(KIT_FILE()));
    const signal = preview.mock.calls[0][1] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(waitingKit()));
    expect(cancel).toHaveBeenCalledWith(KIT_TOKEN);
  });
});

describe("useKitImport after a partial add", () => {
  const threeNew = () =>
    waitingKit({
      entry_count: 3,
      counts: { added: 2, new_version: 1, unchanged: 0 },
      entries: [
        importEntry({ position: 1, name: "Intro" }),
        importEntry({
          position: 2,
          name: "Sponsor",
          outcome: "new_version",
          version: 2,
        }),
        importEntry({ position: 3, name: "Outro", at: "end" }),
      ],
    });

  it("marks the segments that landed first as already there and keeps the rest new", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 1, 3))
      .mockRejectedValueOnce(partial("kit_no_room", 507, 1, 3));
    const { result: hook } = await staged(threeNew());
    const shown = () =>
      hook.current.state.phase === "preview"
        ? hook.current.state.preview
        : null;

    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    await waitFor(() => expect(shown()?.entries[0].outcome).toBe("unchanged"));
    expect(shown()?.entries.map((entry) => entry.outcome)).toEqual([
      "unchanged",
      "new_version",
      "added",
    ]);
    expect(shown()?.counts).toEqual({
      added: 1,
      new_version: 1,
      unchanged: 1,
    });
    expect(shown()?.token).toBe(KIT_TOKEN);

    act(() => hook.current.add());
    await waitFor(() =>
      expect(shown()?.entries.map((entry) => entry.outcome)).toEqual([
        "unchanged",
        "unchanged",
        "added",
      ]),
    );
    expect(shown()?.counts).toEqual({
      added: 1,
      new_version: 0,
      unchanged: 2,
    });
  });

  it("leaves the preview as it was when nothing landed or the drop carried no count", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 0, 3))
      .mockRejectedValueOnce(new ApiError("Gone.", "network_error"));
    const waitingThree = threeNew();
    const { result: hook } = await staged(waitingThree);
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(hook.current.state).toMatchObject({ preview: waitingThree });
  });

  it("treats entries naming one segment as one", () => {
    const twice = waitingKit({
      entry_count: 3,
      counts: { added: 3, new_version: 0, unchanged: 0 },
      entries: [
        importEntry({ position: 1, name: "Bed" }),
        importEntry({ position: 2, name: "Talk" }),
        importEntry({ position: 3, name: "Bed" }),
      ],
    });
    expect(markLanded(twice, 1).entries.map((entry) => entry.outcome)).toEqual([
      "unchanged",
      "added",
      "unchanged",
    ]);
  });
});

describe("useKitImport commit failure wording", () => {
  it("says Added N of M after a partial add when the next try loses the connection", async () => {
    commit
      .mockRejectedValueOnce(partial("kit_busy", 409, 1, 3))
      .mockRejectedValueOnce(
        new ApiError("Couldn't reach the server.", "network_error"),
      );
    const { result: hook } = await staged(waitingKit({ entry_count: 3 }));
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    act(() => hook.current.add());
    await waitFor(() =>
      expect(hook.current.state).toMatchObject({
        notice:
          "Couldn't reach the server. Added 1 of 3 segments. Choose Add to library to finish.",
      }),
    );
  });

  it.each([
    ["a refusal with no code", new ApiError("Odd.", null, 502)],
    ["a network error", new ApiError("Down.", "network_error")],
    ["something that is not an ApiError", new Error("Down.")],
  ])("keeps the preview for %s", async (_shape, failure) => {
    commit.mockRejectedValueOnce(failure);
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("preview"));
    expect(hook.current.state).toMatchObject({
      notice: expect.stringMatching(/Odd\.|Down\./),
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("says 1 segment was added first, in the singular", async () => {
    commit.mockRejectedValueOnce(partial("kit_invalid", 422, 1, 3));
    const { result: hook } = await staged();
    act(() => hook.current.add());
    await waitFor(() => expect(hook.current.state.phase).toBe("error"));
    expect(hook.current.state).toMatchObject({
      message:
        "Detail for kit_invalid. 1 segment was added to your library first.",
    });
  });
});
