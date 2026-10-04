import type { Decorator } from "@storybook/react-vite";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { InspectorSheetStory } from "./InspectorSheetStory";

export const inspectorSheetStoryDecorator: Decorator = (Story) => (
  <InspectorSheetStory>
    <Story />
  </InspectorSheetStory>
);

export const enlargedLandscapeSheet = {
  parameters: {
    ...isolatedStoryParameters,
    viewport: {
      options: {
        shortLandscape: {
          name: "Phone landscape · synthetic 200% text",
          styles: { width: "667px", height: "360px" },
          type: "mobile",
        },
      },
    },
  },
  globals: { viewport: { value: "shortLandscape", isRotated: false } },
};
