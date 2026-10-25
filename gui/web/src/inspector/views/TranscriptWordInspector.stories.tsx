import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Word",
  component: InspectorRailStory,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.word },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Word: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "After" }),
    ).toBeVisible();
  },
};

export const LowConfidence: Story = {
  parameters: { episode: { selection: selections.lowConfidenceWord } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Um," }),
    ).toBeVisible();
  },
};
