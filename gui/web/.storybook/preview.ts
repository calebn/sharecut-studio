import type { Preview } from "@storybook/react-vite";
import { createElement } from "react";
import "../src/styles/daw.css";
import { THEME_OPTIONS, THEME_STORAGE_KEY } from "../src/hooks/useTheme";
import { themePreferenceFromGlobals } from "../src/storybook/docsThemeGlobal";
import { StudioDocsContainer } from "../src/storybook/StudioDocsContainer";
import { StudioStoryTheme } from "../src/storybook/StudioStoryTheme";
import { writeLocal } from "../src/utils/storage";

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        order: [
          "Style guide",
          "System",
          "Stages",
          "Atoms",
          "Molecules",
          "Organisms",
          "Templates",
        ],
      },
    },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
    docs: { container: StudioDocsContainer },
    a11y: {
      options: {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
        },
      },
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
  // The app's theme hook re-applies the stored preference when it mounts, so
  // the toolbar choice has to be the stored one or shell stories lose it.
  beforeEach: ({ globals }) => {
    writeLocal(THEME_STORAGE_KEY, themePreferenceFromGlobals(globals));
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
