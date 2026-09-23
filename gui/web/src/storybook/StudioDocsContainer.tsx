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
