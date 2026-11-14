import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDocumentTitle } from "./useDocumentTitle";

describe("useDocumentTitle", () => {
  it("sets the title while mounted and restores the one it replaced", () => {
    document.title = "ShareCut Studio";
    const { rerender, unmount } = renderHook(
      ({ title }: { title: string | null }) => useDocumentTitle(title),
      { initialProps: { title: "Waiting | Shot of Truth" } },
    );
    expect(document.title).toBe("Waiting | Shot of Truth");
    rerender({ title: "Recording | Shot of Truth" });
    expect(document.title).toBe("Recording | Shot of Truth");
    unmount();
    expect(document.title).toBe("ShareCut Studio");
  });

  it("leaves the title alone while it is null", () => {
    document.title = "ShareCut Studio";
    renderHook(() => useDocumentTitle(null));
    expect(document.title).toBe("ShareCut Studio");
  });
});
