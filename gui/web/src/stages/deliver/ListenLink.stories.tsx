import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { LINK, OPENED_BY } from "./deliverFixture";
import { ListenLink } from "./ListenLink";

const meta: Meta<typeof ListenLink> = {
  title: "Stages/Deliver/ListenLink",
  component: ListenLink,
  tags: ["autodocs"],
  args: {
    pinnedTo: "Rough cut",
    link: null,
    onCopy: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "23.5rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The listen link for the final: a Viewer link pinned to the exported version. There is no Create button; the link is made when it is first copied. After an export, Copy is the filled follow-up.\n\n**Motion.** Animations come later: the Copied label holds for 2 s and then eases back.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ListenLink>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Copy" }),
    );
    await expect(args.onCopy).toHaveBeenCalledOnce();
  },
};

export const Pinned: Story = {
  args: { link: LINK, openedBy: OPENED_BY, pinnedTo: "Final mix" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Pinned to Final mix"),
    ).toBeInTheDocument();
  },
};

export const AfterExport: Story = { args: { link: null, highlight: true } };

export const OfflineOnly: Story = {
  args: { link: LINK, reach: "network" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Only people on this network can listen. Turn on online sharing to reach anyone.",
      ),
    ).toBeInTheDocument();
  },
};

export const OfflineOnlyPhone: Story = {
  args: { link: LINK, reach: "network", share: true, compact: true },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export const OfflineOnlyDark: Story = {
  args: { link: LINK, reach: "network" },
  globals: { theme: "dark" },
};
