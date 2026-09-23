import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, renderHook, waitFor } from "@testing-library/react";
import { themes } from "storybook/theming";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEX_COLOR_RE, studioDocsTheme, useDocumentTheme } from "./docsTheme";

function stubMatchMedia(matches: boolean): {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  const addEventListener = vi.fn();
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches,
    addEventListener,
    removeEventListener,
  }));
  return { addEventListener, removeEventListener };
}

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
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

  it("reads tokens that are plain hex in every brand-tokens.css theme block", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(
      join(here, "../styles/theme/brand-tokens.css"),
      "utf8",
    );
    for (const name of [
      "--color-bg-canvas",
      "--color-text-primary",
      "--color-border",
    ]) {
      const values = [
        ...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g")),
      ].map((m) => m[1].trim());
      // Dark baseline, [data-theme="light"], and prefers-color-scheme: light.
      expect(values, name).toHaveLength(3);
      for (const value of values) {
        expect(value, name).toMatch(HEX_COLOR_RE);
      }
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

  it("removes its change listener on unmount", () => {
    const { removeEventListener } = stubMatchMedia(false);
    const { unmount } = renderHook(() => useDocumentTheme());

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
