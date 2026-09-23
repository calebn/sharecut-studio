import type { Preview } from "@storybook/react-vite";
import "../src/styles/daw.css";
import { applyTheme, isThemePreference } from "../src/hooks/useTheme";
import { StudioDocsContainer } from "../src/storybook/StudioDocsContainer";

const preview: Preview = {
  parameters: {
    options: {
      storySort: { order: ["Atoms", "Molecules", "Organisms", "Templates"] },
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
        items: [
          { value: "system", title: "System" },
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme: unknown = context.globals.theme;
      applyTheme(isThemePreference(theme) ? theme : "system");
      return Story();
    },
  ],
};

export default preview;
