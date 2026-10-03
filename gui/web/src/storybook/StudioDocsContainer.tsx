import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { type PropsWithChildren, useLayoutEffect, useMemo } from "react";
import { GLOBALS_UPDATED } from "storybook/internal/core-events";
import { studioDocsTheme, useDocumentTheme } from "./docsTheme";
import { updateDocsThemeGlobal } from "./docsThemeGlobal";

/**
 * Docs-mode container whose theme follows the Studio toolbar (light / dark /
 * system → prefers-color-scheme) instead of Storybook's default light theme (#209).
 */
export function StudioDocsContainer({
  children,
  context,
}: PropsWithChildren<DocsContainerProps>) {
  useLayoutEffect(() => {
    const story = context.componentStories()[0];
    const updateGlobals = ({
      globals,
    }: {
      globals: Record<string, unknown>;
    }) => {
      updateDocsThemeGlobal(
        story ? context.getStoryContext(story).globals : globals,
      );
    };
    context.channel.on(GLOBALS_UPDATED, updateGlobals);
    if (story) updateDocsThemeGlobal(context.getStoryContext(story).globals);
    else {
      const initialGlobals =
        context.channel.last(GLOBALS_UPDATED)?.[0]?.globals;
      if (initialGlobals) updateDocsThemeGlobal(initialGlobals);
    }
    return () => context.channel.off(GLOBALS_UPDATED, updateGlobals);
  }, [context]);

  const base = useDocumentTheme();
  // Assumes the docs tokens are fully determined by base (light/dark blocks in
  // brand-tokens.css): they are re-read only when base flips, so a token that
  // changes without a flip (new theme variant, HMR edit) stays stale until then.
  const theme = useMemo(() => studioDocsTheme(base), [base]);
  return (
    <DocsContainer context={context} theme={theme}>
      {children}
    </DocsContainer>
  );
}
