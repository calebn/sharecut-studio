import type { Preview } from "@storybook/react-vite";
import { createElement } from "react";
import "../src/styles/daw.css";
import { THEME_OPTIONS } from "../src/hooks/useTheme";
import { themePreferenceFromGlobals } from "../src/storybook/docsThemeGlobal";
import { StudioDocsContainer } from "../src/storybook/StudioDocsContainer";
import { StudioStoryTheme } from "../src/storybook/StudioStoryTheme";

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        order: ["Style guide", "Atoms", "Molecules", "Organisms", "Templates"],
      },
    },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
    docs: { container: StudioDocsContainer },
    a11y: {
      // Reuse the project's axe posture: contrast is enforced by theme
      // tokens, not per-story spot checks.
      options: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description:
        "Light / dark / system Studio theme (sets data-theme on <html>; docs pages follow it)",
      defaultValue: "system",
      toolbar: {
        icon: "paintbrush",
        items: THEME_OPTIONS.map((t) => ({ value: t.id, title: t.label })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      return createElement(
        StudioStoryTheme,
        { preference: themePreferenceFromGlobals(context.globals) },
        createElement(Story),
      );
    },
  ],
};

export default preview;
