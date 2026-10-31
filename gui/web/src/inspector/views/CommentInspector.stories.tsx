import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { selections } from "../../test/episodeFixture";
import { InspectorRailStory } from "../../test/InspectorRailStory";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";

const meta: Meta<typeof InspectorRailStory> = {
  title: "Templates/Editor · Inspector · Comment",
  component: InspectorRailStory,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  parameters: {
    layout: "fullscreen",
    episode: { selection: selections.comment },
  },
};
export default meta;
type Story = StoryObj<typeof InspectorRailStory>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Comment" }),
    ).toBeVisible();
  },
};

export const Resolved: Story = {
  parameters: { episode: { selection: { kind: "comment", id: "comment-3" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Comment" }),
    ).toBeVisible();
    await expect(await canvas.findByText("Resolved by Mira")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Reopen" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Resolve" })).toBeNull();
  },
};

export const Commenter: Story = {
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Comment" }),
    ).toBeVisible();
    // A commenter may reply but not resolve.
    await expect(
      canvas.getByRole("textbox", { name: "Reply to comment" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Resolve" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Reopen" })).toBeNull();
  },
};
