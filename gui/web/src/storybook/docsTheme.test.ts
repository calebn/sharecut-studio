import { act, renderHook, waitFor } from "@testing-library/react";
import { themes } from "storybook/theming";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "../test/matchMedia";
import { studioDocsTheme, useDocumentTheme } from "./docsTheme";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("studioDocsTheme", () => {
  it("builds a dark theme from the live Studio tokens", () => {
    document.documentElement.style.setProperty("--color-bg-canvas", "#191816");
    document.documentElement.style.setProperty(
      "--color-text-primary",
      "#f4f1ea",
    );
    document.documentElement.style.setProperty("--color-border", "#4a4842");

    const theme = studioDocsTheme("dark");

    expect(theme.base).toBe("dark");
    expect(theme.appContentBg).toBe("#191816");
    expect(theme.appPreviewBg).toBe("#191816");
    expect(theme.textColor).toBe("#f4f1ea");
    expect(theme.appBorderColor).toBe("#4a4842");
  });

  it("falls back to Storybook's light theme when no tokens are set", () => {
    const theme = studioDocsTheme("light");

    expect(theme.base).toBe("light");
    expect(theme.appContentBg).toBe(themes.light.appContentBg);
  });

  it("ignores a non-hex token value", () => {
    document.documentElement.style.setProperty(
      "--color-bg-canvas",
      "color-mix(in srgb, red 50%, blue)",
    );

    const theme = studioDocsTheme("dark");

    expect(theme.appContentBg).toBe(themes.dark.appContentBg);
  });

  it("rejects invalid five- and seven-digit hex tokens", () => {
    for (const invalid of ["#12345", "#1234567"]) {
      document.documentElement.style.setProperty("--color-bg-canvas", invalid);
      expect(studioDocsTheme("dark").appContentBg).toBe(
        themes.dark.appContentBg,
      );
    }
  });
});

describe("useDocumentTheme", () => {
  it("tracks the OS preference and explicit data-theme changes", async () => {
    stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useDocumentTheme());

    expect(result.current).toBe("dark");

    act(() => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => expect(result.current).toBe("light"));

    unmount();
  });

  it("follows an OS scheme change while System is selected", () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useDocumentTheme());

    expect(result.current).toBe("dark");

    act(() => media.setMatches(true));
    expect(result.current).toBe("light");

    act(() => media.setMatches(false));
    expect(result.current).toBe("dark");

    unmount();
  });

  it("removes its change listener and disconnects its observer on unmount", () => {
    const { removeEventListener } = stubMatchMedia(false);
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = renderHook(() => useDocumentTheme());

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(disconnect).toHaveBeenCalled();
  });
});
