import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: listed.list,
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
const PATH = "/tmp/ep/episode.sharecut";

beforeEach(() => {
  listed.list.mockReset();
  listed.list.mockResolvedValue([ENTRY]);
});

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
});
