import type { DocsContainerProps } from "@storybook/addon-docs/blocks";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Channel } from "storybook/internal/channels";
import { GLOBALS_UPDATED } from "storybook/internal/core-events";
import type { ThemeVars } from "storybook/theming";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "../test/matchMedia";
import { updateDocsThemeGlobal } from "./docsThemeGlobal";
import { StudioDocsContainer } from "./StudioDocsContainer";

const seen = vi.hoisted(() => ({
  themes: [] as ThemeVars[],
  contexts: [] as unknown[],
}));

// Record what reaches Storybook's DocsContainer; render children only (no JSX in the factory).
vi.mock("@storybook/addon-docs/blocks", () => ({
  DocsContainer: ({
    theme,
    context,
    children,
  }: {
    theme: ThemeVars;
    context: unknown;
    children?: ReactNode;
  }) => {
    seen.themes.push(theme);
    seen.contexts.push(context);
    return children;
  },
}));

let channel = new Channel({});
const componentStories = vi.fn(() => [{ id: "dialog--default" }]);
componentStories.mockReturnValue([]);
const getStoryContext = vi.fn(() => ({ globals: { theme: "system" } }));
const context = {
  get channel() {
    return channel;
  },
  componentStories,
  getStoryContext,
} as unknown as DocsContainerProps["context"];

afterEach(() => {
  updateDocsThemeGlobal({ theme: "system" });
  delete document.documentElement.dataset.theme;
  seen.themes.length = 0;
  seen.contexts.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  channel = new Channel({});
  componentStories.mockReturnValue([]);
  getStoryContext.mockReturnValue({ globals: { theme: "system" } });
});

describe("StudioDocsContainer", () => {
  it("applies initial story globals despite the opposite OS theme", async () => {
    stubMatchMedia(false);
    componentStories.mockReturnValue([{ id: "dialog--default" }]);
    getStoryContext.mockReturnValue({ globals: { theme: "light" } });
    render(
      <StudioDocsContainer context={context}>
        <p>Docs body</p>
      </StudioDocsContainer>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("light"));
  });

  it("uses owning Docs globals when nested stories broadcast defaults", async () => {
    componentStories.mockReturnValue([{ id: "dialog--default" }]);
    getStoryContext.mockReturnValue({ globals: { theme: "light" } });
    render(
      <StudioDocsContainer context={context}>
        <p>Docs body</p>
      </StudioDocsContainer>,
    );
    act(() => channel.emit(GLOBALS_UPDATED, { globals: { theme: "system" } }));
    expect(document.documentElement.dataset.theme).toBe("light");
    getStoryContext.mockReturnValue({ globals: { theme: "dark" } });
    act(() => channel.emit(GLOBALS_UPDATED, { globals: { theme: "system" } }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("dark"));
  });

  it("initializes standalone MDX from the channel's most recent toolbar event", async () => {
    stubMatchMedia(false);
    channel.emit(GLOBALS_UPDATED, { globals: { theme: "light" } });
    render(
      <StudioDocsContainer context={context}>
        <p>Standalone MDX</p>
      </StudioDocsContainer>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("light"));
  });

  it("tracks live toolbar events for standalone MDX without stories", async () => {
    stubMatchMedia(false);
    render(
      <StudioDocsContainer context={context}>
        <p>Standalone MDX</p>
      </StudioDocsContainer>,
    );
    act(() => channel.emit(GLOBALS_UPDATED, { globals: { theme: "light" } }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("light"));
    act(() => channel.emit(GLOBALS_UPDATED, { globals: { theme: "dark" } }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("dark"));
    act(() => channel.emit(GLOBALS_UPDATED, { globals: { theme: "system" } }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("preserves an existing MDX theme and unregisters its live listener", () => {
    updateDocsThemeGlobal({ theme: "light" });
    const { unmount } = render(
      <StudioDocsContainer context={context}>
        <p>Standalone MDX</p>
      </StudioDocsContainer>,
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    unmount();
    channel.emit(GLOBALS_UPDATED, { globals: { theme: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("passes context, children and a theme that follows data-theme", async () => {
    stubMatchMedia(false);
    const { getByText } = render(
      <StudioDocsContainer context={context}>
        <p>Docs body</p>
      </StudioDocsContainer>,
    );

    expect(getByText("Docs body")).toBeInTheDocument();
    expect(seen.contexts.at(-1)).toBe(context);
    expect(seen.themes.at(-1)?.base).toBe("dark");
    const darkTheme = seen.themes.at(-1);

    act(() => {
      document.documentElement.dataset.theme = "light";
    });

    await waitFor(() => expect(seen.themes.at(-1)?.base).toBe("light"));
    expect(seen.themes.at(-1)).not.toBe(darkTheme);
  });

  it("reuses the memoized theme while the base is unchanged", () => {
    stubMatchMedia(false);
    const { rerender } = render(
      <StudioDocsContainer context={context}>
        <p>Docs body</p>
      </StudioDocsContainer>,
    );
    const first = seen.themes.at(-1);

    rerender(
      <StudioDocsContainer context={context}>
        <p>Docs body again</p>
      </StudioDocsContainer>,
    );

    expect(seen.themes.length).toBeGreaterThan(1);
    expect(seen.themes.at(-1)).toBe(first);
  });
});
