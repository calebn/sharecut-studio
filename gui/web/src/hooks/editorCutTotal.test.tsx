import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getEditorCutTotal } from "../api";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { EditorCutTotalProvider } from "./EditorCutTotalProvider";
import { useCutTotal } from "./useEditorCutTotal";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  getEditorCutTotal: vi.fn(),
}));
const fetchImpact = vi.mocked(getEditorCutTotal);

beforeEach(() => {
  fetchImpact.mockReset();
});

it("discards the previous edit's delayed total and gives both consumers the fresh value", async () => {
  const old = deferred<number>();
  const fresh = deferred<number>();
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
  const previousSignal = fetchImpact.mock.calls[0]?.[1];
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
    fresh.resolve(2.5);
  });
  await waitFor(() => expect(result.current).toEqual([2.5, 2.5]));
  await act(async () => {
    old.resolve(9);
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
