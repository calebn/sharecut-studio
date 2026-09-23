import type { DocsContainerProps } from "@storybook/addon-docs/blocks";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ThemeVars } from "storybook/theming";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function stubDarkOs(): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const context = {
  marker: "docs-context",
} as unknown as DocsContainerProps["context"];

afterEach(() => {
  delete document.documentElement.dataset.theme;
  seen.themes.length = 0;
  seen.contexts.length = 0;
  vi.unstubAllGlobals();
});

describe("StudioDocsContainer", () => {
  it("passes context, children and a theme that follows data-theme", async () => {
    stubDarkOs();
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
    stubDarkOs();
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
