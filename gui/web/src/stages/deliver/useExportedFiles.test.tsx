import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ list: vi.fn(), guest: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: listed.list,
  readGuestExportedFiles: listed.guest,
}));

import { useExportedFiles } from "./useExportedFiles";

const ENTRY = {
  id: "clips/a.wav",
  name: "a.wav",
  kind: "audio",
  label: "Clip",
  bytes: 5,
  current: true,
  ticket: "1700000000.5-9.sig",
};
const ARCHIVE = {
  name: "episode-export.zip",
  count: 1,
  bytes: 61,
  ticket: "1700000000.abc-1.sig",
};
const inventory = (files: unknown[], archive: unknown = null) => ({
  inventory: { files, archive },
});
const PATH = "/tmp/ep/episode.sharecut";

beforeEach(() => {
  listed.list.mockReset();
  listed.list.mockResolvedValue({ files: [ENTRY], archive: ARCHIVE });
  listed.guest
    .mockReset()
    .mockResolvedValue({ ...inventory([ENTRY]), revision: "first" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));
const GUEST_PATH = "share:guest";

describe("useExportedFiles", () => {
  it("lists the folder and gives each row a link only for download access", async () => {
    const download = renderHook(() =>
      useExportedFiles(PATH, { access: "download" }),
    );
    await waitFor(() => expect(download.result.current.load).toBe("ready"));
    expect(download.result.current.files[0]?.href).toContain(
      "/api/export/files/clips/a.wav",
    );
    expect(download.result.current.files[0]?.href).toContain(
      "ticket=1700000000.5-9.sig",
    );
    const reveal = renderHook(() =>
      useExportedFiles(PATH, { access: "reveal" }),
    );
    await waitFor(() => expect(reveal.result.current.load).toBe("ready"));
    expect(reveal.result.current.files[0]?.href).toBeUndefined();
  });

  it("links the archive with its ticket for a host download and leaves it out for a reveal", async () => {
    const download = renderHook(() =>
      useExportedFiles(PATH, { access: "download" }),
    );
    await waitFor(() => expect(download.result.current.load).toBe("ready"));
    expect(download.result.current.archive).toEqual({
      name: "episode-export.zip",
      count: 1,
      bytes: 61,
      href: `/api/export/archive?path=${encodeURIComponent(PATH)}&ticket=1700000000.abc-1.sig`,
    });
    const reveal = renderHook(() =>
      useExportedFiles(PATH, { access: "reveal" }),
    );
    await waitFor(() => expect(reveal.result.current.load).toBe("ready"));
    expect(reveal.result.current.archive).toBeNull();
  });

  it("gives a guest the archive link with no ticket", async () => {
    listed.guest.mockResolvedValue({
      ...inventory([ENTRY], { ...ARCHIVE, ticket: undefined }),
      revision: "first",
    });
    const { result } = renderHook(() =>
      useExportedFiles(GUEST_PATH, {
        access: "download",
        watchGuestPublication: true,
      }),
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    expect(result.current.archive?.href).toBe(
      "/api/review/guest/daw/export/archive",
    );
  });

  it("reads again when the refresh key changes and when the window regains focus", async () => {
    const { result, rerender } = renderHook(
      ({ key }) =>
        useExportedFiles(PATH, { access: "download", refreshKey: key }),
      { initialProps: { key: "a" } },
    );
    await waitFor(() => expect(result.current.load).toBe("ready"));
    expect(listed.list).toHaveBeenCalledTimes(1);
    rerender({ key: "b" });
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(3));
  });

  it("reports a failed read and reads nothing without a path", async () => {
    listed.list.mockRejectedValue(new Error("down"));
    const failed = renderHook(() =>
      useExportedFiles(PATH, { access: "download" }),
    );
    await waitFor(() => expect(failed.result.current.load).toBe("error"));
    expect(failed.result.current.files).toEqual([]);
    listed.list.mockClear();
    const none = renderHook(() =>
      useExportedFiles(null, { access: "download" }),
    );
    expect(none.result.current.load).toBe("loading");
    expect(listed.list).not.toHaveBeenCalled();
  });

  it("checks only when visible and after the preceding guest read settles", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { result } = renderHook(() =>
      useExportedFiles(GUEST_PATH, {
        access: "download",
        watchGuestPublication: true,
      }),
    );
    await advance(30_000);
    expect(result.current.currentLoad).toBe("ready");
    expect(listed.guest).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    let fail = () => {};
    listed.guest.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error("temporary failure"));
        }),
    );
    await advance(30_000);
    expect(listed.guest).toHaveBeenCalledTimes(2);
    expect(listed.guest.mock.lastCall?.[1]).toBe("first");
    await advance(60_000);
    expect(listed.guest).toHaveBeenCalledTimes(2);
    expect(result.current.currentLoad).toBe("ready");
    expect(result.current.files[0]?.name).toBe("a.wav");

    await act(async () => fail());
    expect(result.current.currentLoad).toBe("ready");
    listed.guest.mockResolvedValueOnce({
      ...inventory([{ ...ENTRY, name: "new.wav" }]),
      revision: "second",
    });
    await advance(30_000);
    expect(result.current.files[0]?.name).toBe("new.wav");
    expect(result.current.currentLoad).toBe("ready");
  });

  it("polls every 5 s while an export runs and keeps that across a revision-only reply", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    listed.guest.mockResolvedValue({
      ...inventory([ENTRY]),
      revision: "first",
      exporting: true,
    });
    const { result } = renderHook(() =>
      useExportedFiles(GUEST_PATH, {
        access: "download",
        watchGuestPublication: true,
      }),
    );
    await advance(0);
    expect(result.current.exporting).toBe(true);
    expect(listed.guest).toHaveBeenCalledTimes(1);

    listed.guest.mockResolvedValue({
      inventory: null,
      revision: "first",
      exporting: null,
    });
    await advance(5_000);
    expect(listed.guest).toHaveBeenCalledTimes(2);
    expect(result.current.exporting).toBe(true);
    await advance(5_000);
    expect(listed.guest).toHaveBeenCalledTimes(3);

    listed.guest.mockResolvedValue({
      ...inventory([ENTRY]),
      revision: "second",
      exporting: false,
    });
    await advance(5_000);
    expect(result.current.exporting).toBe(false);
    await advance(29_000);
    expect(listed.guest).toHaveBeenCalledTimes(4);
    await advance(1_000);
    expect(listed.guest).toHaveBeenCalledTimes(5);
  });

  it("stops reporting an export when a foreground re-read fails", async () => {
    listed.guest.mockResolvedValueOnce({
      ...inventory([ENTRY]),
      revision: "first",
      exporting: true,
    });
    const { result } = renderHook(() =>
      useExportedFiles(GUEST_PATH, {
        access: "download",
        watchGuestPublication: true,
      }),
    );
    await waitFor(() => expect(result.current.exporting).toBe(true));
    listed.guest.mockRejectedValue(new Error("down"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.currentLoad).toBe("error"));
    expect(result.current.exporting).toBe(false);
  });

  it("a foreground refresh cancels quiet work and cannot be superseded by it", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const { result, rerender } = renderHook(
      ({ path }) =>
        useExportedFiles(path, {
          access: "download",
          watchGuestPublication: true,
        }),
      { initialProps: { path: GUEST_PATH as string | null } },
    );
    await advance(0);
    let finishQuiet = () => {};
    listed.guest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuiet = () =>
            resolve({
              ...inventory([{ ...ENTRY, name: "stale.wav" }]),
              revision: "stale",
            });
        }),
    );
    await advance(30_000);
    const quietSignal = listed.guest.mock.lastCall?.[2] as AbortSignal;
    expect(quietSignal.aborted).toBe(false);
    listed.guest.mockResolvedValueOnce({
      ...inventory([{ ...ENTRY, name: "fresh.wav" }]),
      revision: "fresh",
    });
    act(() => result.current.reload());
    await advance(0);
    expect(quietSignal.aborted).toBe(true);
    expect(listed.guest.mock.lastCall?.[1]).toBe("");
    await act(async () => finishQuiet());
    expect(result.current.files[0]?.name).toBe("fresh.wav");
    rerender({ path: null });
    await advance(60_000);
    expect(listed.guest).toHaveBeenCalledTimes(3);
    expect(result.current.files).toEqual([]);
  });
});
