import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: listed.list,
}));

import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import type { HistoryEntryId } from "../../types/project";
import { type ExportFlow, Flow } from "../hosts/exportFlowContext";
import { useDeliverBadge } from "./useDeliverBadge";

const flow = { current: { run: { kind: "idle" } } as ExportFlow };

const file = (kind: string, current: boolean) => ({
  id: `${kind}/${current}`,
  name: `${kind}.file`,
  kind,
  label: kind,
  bytes: 5,
  current,
  ticket: "1700000000.5-9.sig",
});

beforeEach(() => {
  listed.list.mockReset();
  listed.list.mockResolvedValue([]);
  flow.current = { run: { kind: "idle" } } as ExportFlow;
  useDawStore.setState({
    projectPath: "/tmp/ep/episode.sharecut",
    guestMode: null,
    project: minimalProject(),
  });
});

describe("useDeliverBadge", () => {
  it("has no badge before the first export", async () => {
    const { result } = renderHook(() => useDeliverBadge());
    await waitFor(() => expect(listed.list).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("checks the tab while an audio file is current", async () => {
    listed.list.mockResolvedValue([file("audio", true), file("feed", false)]);
    const { result } = renderHook(() => useDeliverBadge());
    await waitFor(() => expect(result.current).toEqual({ kind: "done" }));
  });

  it("shows a dot when every audio file is older than the latest edit", async () => {
    listed.list.mockResolvedValue([file("audio", false), file("feed", true)]);
    const { result } = renderHook(() => useDeliverBadge());
    await waitFor(() => expect(result.current).toEqual({ kind: "needs-you" }));
  });

  it("ignores transcripts and feeds with no audio file beside them", async () => {
    listed.list.mockResolvedValue([file("transcript", true)]);
    const { result } = renderHook(() => useDeliverBadge());
    await waitFor(() => expect(listed.list).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it("reads the listing again when a failed run settles", async () => {
    const { rerender } = renderHook(() => useDeliverBadge(), {
      wrapper: ({ children }) => (
        <Flow.Provider value={flow.current}>{children}</Flow.Provider>
      ),
    });
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(1));
    flow.current = { run: { kind: "failed", reason: "x" } } as ExportFlow;
    rerender();
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(2));
  });

  it("never lists the folder with no project open", () => {
    useDawStore.setState({ projectPath: "" });
    const { result } = renderHook(() => useDeliverBadge());
    expect(result.current).toBeUndefined();
    expect(listed.list).not.toHaveBeenCalled();
  });

  it("reads the listing again after an edit", async () => {
    renderHook(() => useDeliverBadge());
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(1));
    act(() => {
      useDawStore.setState({
        project: {
          ...minimalProject(),
          history: {
            ...minimalProject().history,
            head_id: "after-edit" as HistoryEntryId,
          },
        },
      });
    });
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(2));
  });

  it("keeps the badge while the next listing loads", async () => {
    listed.list.mockResolvedValueOnce([file("audio", true)]);
    const { result } = renderHook(() => useDeliverBadge());
    await waitFor(() => expect(result.current).toEqual({ kind: "done" }));
    listed.list.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listed.list).toHaveBeenCalledTimes(2));
    expect(result.current).toEqual({ kind: "done" });
  });

  it("never lists the folder for a guest", async () => {
    useDawStore.setState({ guestMode: "view" });
    const { result } = renderHook(() => useDeliverBadge());
    expect(result.current).toBeUndefined();
    expect(listed.list).not.toHaveBeenCalled();
  });
});
