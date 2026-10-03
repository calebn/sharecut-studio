import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvedDocumentTheme } from "../hooks/useTheme";
import { stubMatchMedia } from "../test/matchMedia";
import { updateDocsThemeGlobal } from "./docsThemeGlobal";
import { StudioStoryTheme } from "./StudioStoryTheme";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function docsFrame() {
  const parentDocument = document.implementation.createHTMLDocument("Docs");
  const frame = parentDocument.createElement("iframe");
  frame.id = "iframe--organisms-dialog--default";
  parentDocument.body.append(frame);
  vi.spyOn(window, "frameElement", "get").mockReturnValue(frame);
  return parentDocument.documentElement;
}

describe("StudioStoryTheme", () => {
  it("applies standalone story preferences and toolbar updates", () => {
    const { getByText, rerender } = render(
      <StudioStoryTheme preference="light">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(getByText("Story")).toBeVisible();
    expect(document.documentElement.dataset.theme).toBe("light");
    rerender(
      <StudioStoryTheme preference="dark">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    rerender(
      <StudioStoryTheme preference="system">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("reads and follows the parent Docs toolbar instead of iframe default globals", async () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "light";
    const { unmount } = render(
      <StudioStoryTheme preference="system">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => {
      parentRoot.dataset.theme = "dark";
    });
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    unmount();
  });

  it("lets System follow the OS after the parent removes its override", async () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "dark";
    const media = stubMatchMedia(true);
    const { unmount } = render(
      <StudioStoryTheme preference="light">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => {
      delete parentRoot.dataset.theme;
    });
    await waitFor(() =>
      expect(document.documentElement).not.toHaveAttribute("data-theme"),
    );
    expect(resolvedDocumentTheme()).toBe("light");
    act(() => media.setMatches(false));
    expect(resolvedDocumentTheme()).toBe("dark");
    unmount();
  });

  it("treats an invalid parent override as System", () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "unknown";
    render(
      <StudioStoryTheme preference="dark">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("does not inherit theme from unrelated iframe hosts", () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "light";
    const frame = parentRoot.querySelector("iframe");
    if (frame) frame.id = "storybook-preview-iframe";
    render(
      <StudioStoryTheme preference="dark">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ignores nested iframe default globals after inheriting the parent theme", () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "light";
    render(
      <StudioStoryTheme preference="system">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    updateDocsThemeGlobal({ theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("disconnects the parent observer on unmount", async () => {
    const parentRoot = docsFrame();
    parentRoot.dataset.theme = "light";
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(
      <StudioStoryTheme preference="system">
        <p>Story</p>
      </StudioStoryTheme>,
    );
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    parentRoot.dataset.theme = "dark";
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
