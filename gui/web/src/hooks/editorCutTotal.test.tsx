import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiFetch } from "../api/http";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { EditorCutTotalProvider } from "./EditorCutTotalProvider";
import { useCutTotal } from "./useEditorCutTotal";

vi.mock("../api/http", async (original) => ({
  ...(await original<typeof import("../api/http")>()),
  apiFetch: vi.fn(),
}));
const fetchImpact = vi.mocked(apiFetch);

beforeEach(() => {
  fetchImpact.mockReset();
});

it("discards the previous edit's delayed total and gives both consumers the fresh value", async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  fetchImpact
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const before = minimalProject();
  useDawStore.setState({
    projectPath: "share:editor",
    shareCapabilities: ["edit"],
    project: before,
  });
  const { result } = renderHook(() => [useCutTotal(0), useCutTotal(0)], {
    wrapper: EditorCutTotalProvider,
  });
  expect(result.current).toEqual([null, null]);
  expect(fetchImpact).toHaveBeenCalledTimes(1);
  const previousSignal = fetchImpact.mock.calls[0]?.[2]?.signal;
  act(() => {
    useDawStore.setState({
      project: {
        ...before,
        history: {
          ...before.history,
          edit_head_id: "second" as HistoryEntryId,
        },
      },
    });
  });
  expect(previousSignal?.aborted).toBe(true);
  expect(fetchImpact).toHaveBeenCalledTimes(2);
  await act(async () => {
    fresh.resolve(Response.json({ total_removed_sec: 2.5 }));
  });
  await waitFor(() => expect(result.current).toEqual([2.5, 2.5]));
  await act(async () => {
    old.resolve(Response.json({ total_removed_sec: 9 }));
  });
  expect(result.current).toEqual([2.5, 2.5]);
});

it.each([["view"], ["view", "comment"]])(
  "leaves the existing total alone without an Editor capability",
  (...capabilities) => {
    useDawStore.setState({
      projectPath: "share:guest",
      shareCapabilities: capabilities,
      project: minimalProject(),
    });
    const { result } = renderHook(() => useCutTotal(0), {
      wrapper: EditorCutTotalProvider,
    });
    expect(result.current).toBe(0);
    expect(fetchImpact).not.toHaveBeenCalled();
  },
);
