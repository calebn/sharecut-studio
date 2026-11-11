import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  listExportedFiles: listed.list,
}));

import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import { useDeliverBadge } from "./useDeliverBadge";

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

  it("never lists the folder for a guest", async () => {
    useDawStore.setState({ guestMode: "review" as never });
    const { result } = renderHook(() => useDeliverBadge());
    expect(result.current).toBeUndefined();
    expect(listed.list).not.toHaveBeenCalled();
  });
});
