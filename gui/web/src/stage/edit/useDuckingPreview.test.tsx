import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DuckingPlan, previewDucking } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import type { HistoryEntryId } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import {
  DUCKING_PREVIEW_DEBOUNCE_MS,
  useDuckingPreview,
} from "./useDuckingPreview";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  previewDucking: vi.fn(),
}));

const plan = (changed: boolean, replacedEarlierDips = 0): DuckingPlan => ({
  planToken: "t",
  depthDb: -18,
  tracks: [{ trackId: "m", changed, replacedEarlierDips, simplified: false }],
});

const settle = async (ms = DUCKING_PREVIEW_DEBOUNCE_MS) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function moveHistoryTo(head: string) {
  const project = useDawStore.getState().project;
  if (!project) throw new Error("no project");
  act(() => {
    useDawStore.getState().hydrate("/tmp/ep.json", {
      ...project,
      history: { ...project.history, head_id: head as HistoryEntryId },
    });
  });
}

describe("useDuckingPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(previewDucking).mockReset();
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out the debounce, then reports a plan that writes first dips as ready", async () => {
    vi.mocked(previewDucking).mockResolvedValue(plan(true));
    const { result } = renderHook(() => useDuckingPreview(true));
    expect(result.current).toEqual({ kind: "checking" });
    await settle(DUCKING_PREVIEW_DEBOUNCE_MS - 1);
    expect(previewDucking).not.toHaveBeenCalled();
    await settle(1);
    expect(previewDucking).toHaveBeenCalledExactlyOnceWith("/tmp/ep.json");
    expect(result.current).toEqual({ kind: "ready", plan: plan(true) });
  });

  it("calls a plan that would replace earlier dips stale, and one that changes nothing current", async () => {
    vi.mocked(previewDucking).mockResolvedValueOnce(plan(true, 3));
    const { result } = renderHook(() => useDuckingPreview(true));
    await settle();
    expect(result.current.kind).toBe("stale");
    vi.mocked(previewDucking).mockResolvedValueOnce(plan(false, 3));
    moveHistoryTo("hist_2");
    await settle();
    expect(result.current.kind).toBe("current");
  });

  it("plans again once, after a burst of edits, not once per edit", async () => {
    vi.mocked(previewDucking).mockResolvedValue(plan(false));
    renderHook(() => useDuckingPreview(true));
    await settle();
    expect(previewDucking).toHaveBeenCalledTimes(1);
    moveHistoryTo("hist_2");
    await settle(DUCKING_PREVIEW_DEBOUNCE_MS / 2);
    moveHistoryTo("hist_3");
    await settle(DUCKING_PREVIEW_DEBOUNCE_MS);
    expect(previewDucking).toHaveBeenCalledTimes(2);
  });

  it("drops a late answer for an episode that has moved on", async () => {
    let late: (p: DuckingPlan) => void = () => {};
    vi.mocked(previewDucking)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          late = resolve;
        }),
      )
      .mockResolvedValueOnce(plan(false));
    const { result } = renderHook(() => useDuckingPreview(true));
    await settle();
    moveHistoryTo("hist_2");
    await settle();
    expect(result.current.kind).toBe("current");
    await act(async () => late(plan(true, 2)));
    expect(result.current.kind).toBe("current");
  });

  it.each([
    ["ducking_no_targets", 400, "none"],
    ["ducking_no_dialogue_activity", 400, "silent"],
    ["document_conflict", 409, "changed"],
  ])("maps a %s refusal to %s", async (code, status, kind) => {
    vi.mocked(previewDucking).mockRejectedValue(
      new ApiError("x", code, status),
    );
    const { result } = renderHook(() => useDuckingPreview(true));
    await settle();
    expect(result.current).toEqual({ kind });
  });

  it("calls any other failure unreachable, so the host can still duck", async () => {
    vi.mocked(previewDucking).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useDuckingPreview(true));
    await settle();
    expect(result.current).toEqual({ kind: "unreachable" });
  });

  it("sends nothing while disabled", async () => {
    renderHook(() => useDuckingPreview(false));
    await settle(DUCKING_PREVIEW_DEBOUNCE_MS * 3);
    expect(previewDucking).not.toHaveBeenCalled();
  });
});
