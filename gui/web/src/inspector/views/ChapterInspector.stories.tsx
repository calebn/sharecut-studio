import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Chapter",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
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
    await expect(
      canvas.getByRole("textbox", { name: "Chapter title" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("spinbutton", { name: "Chapter time" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Delete" })).toBeVisible();
  },
};

export const Viewer: Story = {
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "The harbor depot" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("textbox", { name: "Chapter title" }),
    ).toBeNull();
    await expect(
      canvas.queryByRole("spinbutton", { name: "Chapter time" }),
    ).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Delete" })).toBeNull();
    await expect(canvas.getByText("Time").nextElementSibling).toHaveTextContent(
      "01:04.000",
    );
  },
};
