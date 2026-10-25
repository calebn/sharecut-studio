import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Chapter",
  component: InspectorRailStory,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.chapter },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Host: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "The harbor depot" }),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "The harbor depot" }),
    ).toBeVisible();
  },
};
