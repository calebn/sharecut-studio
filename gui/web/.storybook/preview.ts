import type { Preview } from "@storybook/react-vite";
import "../src/styles/daw.css";

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
    a11y: {
      // Reuse the project's axe posture: contrast is enforced by theme
      // tokens, not per-story spot checks.
      options: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
    },
  },
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Light / dark Studio theme (sets data-theme on <html>)",
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
      const theme = context.globals.theme as string;
      if (theme === "system") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.dataset.theme = theme;
      }
      return Story();
    },
  ],
};

export default preview;
