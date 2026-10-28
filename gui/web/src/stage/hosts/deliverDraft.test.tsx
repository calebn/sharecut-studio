import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deferred } from "../../test/deferred";
import {
  patchDeliverDraft,
  sendDeliverEdit,
  useDeliverDraft,
} from "./deliverDraft";

describe("deliver drafts", () => {
  it("keeps each project's pending count and refusal apart", async () => {
    const first = renderHook(() => useDeliverDraft("/draft/a.json"));
    const second = renderHook(() => useDeliverDraft("/draft/b.json"));
    const late = deferred();
    act(() => sendDeliverEdit("/draft/a.json", () => late.promise));
    act(() =>
      sendDeliverEdit("/draft/b.json", async () => {
        throw new Error("no");
      }),
    );
    await act(async () => {});
    expect(first.result.current).toMatchObject({ pending: 1, unsaved: false });
    expect(second.result.current).toMatchObject({ pending: 0, unsaved: true });
    await act(async () => late.resolve());
    expect(first.result.current.pending).toBe(0);
    patchDeliverDraft("/draft/a.json", () => ({ unsaved: true }));
    expect(second.result.current.unsaved).toBe(true);
  });
});
