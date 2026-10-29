import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { emptyEpisode } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { episodeBeforeEach, withEpisode } from "../test/withEpisode";
import { CommentsPanel } from "./CommentsPanel";

const meta: Meta<typeof CommentsPanel> = {
  title: "Templates/Editor · Comments panel",
  component: CommentsPanel,
  beforeEach: episodeBeforeEach,
  decorators: [panelFrame, withEpisode],
  parameters: { layout: "fullscreen", episode: {} },
};
export default meta;
type Story = StoryObj<typeof CommentsPanel>;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Can we trim the pause before this answer?"),
    ).toBeVisible();
    await expect(
      canvas.queryByText("Fixed the spelling", { exact: false }),
    ).toBeNull();
  },
};

export const ResolvedFilter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Resolved" }),
    );
    await expect(
      await canvas.findByText("Fixed the spelling of the newsletter name."),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  parameters: { episode: { project: emptyEpisode() } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Open" }),
    ).toBeVisible();
  },
};

export const Phone: Story = { parameters: { framePhone: true } };
