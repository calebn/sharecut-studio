import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tauri: false,
  list: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.tauri }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: mocks.list,
  revealExportedFile: mocks.reveal,
}));

import { useDawStore } from "../../state/dawStore";
import { hostFileAccess, useDeliverFiles } from "./useDeliverFiles";

const PATH = "/tmp/ep/episode.sharecut";
const ENTRY = {
  id: "ep.mp3",
  name: "ep.mp3",
  kind: "audio",
  label: "Listening file",
  bytes: 5,
  current: true,
};

beforeEach(() => {
  mocks.tauri = false;
  mocks.list.mockReset().mockResolvedValue([ENTRY]);
  mocks.reveal.mockReset().mockResolvedValue(undefined);
  useDawStore.setState({ statusMessage: null } as never);
});

describe("hostFileAccess", () => {
  it("reveals in the desktop app and downloads in a browser", () => {
    mocks.tauri = true;
    expect(hostFileAccess()).toBe("reveal");
    mocks.tauri = false;
    expect(hostFileAccess()).toBe("download");
  });
});

describe("useDeliverFiles", () => {
  it("reveals the file pressed through the host in the app", async () => {
    const { result } = renderHook(() => useDeliverFiles(PATH, "reveal"));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    result.current.onReveal?.(result.current.files[0] as never);
    expect(mocks.reveal).toHaveBeenCalledWith(PATH, "ep.mp3");
  });

  it("gives downloads a link and says the download started", async () => {
    const announce = vi.fn();
    useDawStore.setState({ announceStatus: announce } as never);
    const { result } = renderHook(() => useDeliverFiles(PATH, "download"));
    await waitFor(() => expect(result.current.load).toBe("ready"));
    expect(result.current.files[0]?.href).toContain("/api/export/files/ep.mp3");
    result.current.onStarted?.(result.current.files[0] as never);
    expect(announce).toHaveBeenCalledWith(
      "Download started. Check your downloads.",
      expect.anything(),
    );
  });

  it("reads nothing for a null path", () => {
    renderHook(() => useDeliverFiles(null, "download"));
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
