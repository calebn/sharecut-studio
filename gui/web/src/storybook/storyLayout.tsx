import type { Decorator, Parameters } from "@storybook/react-vite";
import "./story-layout.css";

export const viewportStoryParameters = {
  layout: "fullscreen",
  docs: { canvas: { className: "studio-story-viewport" } },
} satisfies Parameters;

export const isolatedStoryParameters = {
  ...viewportStoryParameters,
  docs: {
    ...viewportStoryParameters.docs,
    story: { inline: false, height: "40rem" },
  },
} satisfies Parameters;

export const desktopStoryParameters = {
  ...isolatedStoryParameters,
  docs: {
    ...isolatedStoryParameters.docs,
    canvas: {
      className: "studio-story-viewport studio-story-viewport--desktop",
    },
  },
} satisfies Parameters;

export const menuStoryDecorator: Decorator = (Story) => (
  <div
    style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-end",
      minBlockSize: "18rem",
    }}
  >
    <Story />
  </div>
);
