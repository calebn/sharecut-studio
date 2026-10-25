import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { emptyEpisode } from "../test/episodeFixture";
import { panelFrame } from "../test/panelFrame";
import { withEpisode } from "../test/withEpisode";
import { CommentsPanel } from "./CommentsPanel";

const meta: Meta<typeof CommentsPanel> = {
  title: "Templates/Editor · Comments panel",
  component: CommentsPanel,
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

export const GuestCommenter: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("textbox", { name: "Comment" }),
    ).toBeVisible();
  },
};

export const GuestNameStep: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "commenter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Comment" }),
      "The cold open runs long.",
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Post comment" }),
    );
    await expect(
      await canvas.findByRole("textbox", { name: "Your name" }),
    ).toBeVisible();
  },
};

export const Viewer: Story = {
  args: { guestShare: true },
  parameters: { episode: { role: "viewer" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Can we trim the pause before this answer?"),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Comment" })).toBeNull();
  },
};

export const Phone: Story = { parameters: { dawShellPhone: true } };
