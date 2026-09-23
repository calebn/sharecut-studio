import {
  DocsContainer,
  type DocsContainerProps,
} from "@storybook/addon-docs/blocks";
import { type PropsWithChildren, useMemo } from "react";
import { studioDocsTheme, useDocumentTheme } from "./docsTheme";

/**
 * Docs-mode container whose theme follows the Studio toolbar (light / dark /
 * system → prefers-color-scheme) instead of Storybook's default light theme (#209).
 */
export function StudioDocsContainer({
  children,
  context,
}: PropsWithChildren<DocsContainerProps>) {
  const base = useDocumentTheme();
  // Tokens are read after data-theme changes, so recompute when the base flips.
  const theme = useMemo(() => studioDocsTheme(base), [base]);
  return (
    <DocsContainer context={context} theme={theme}>
      {children}
    </DocsContainer>
  );
}
