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

export const Copied: Story = {
  args: { link: LINK, copyState: "copied", openedBy: OPENED_BY },
};

export const ClipboardBlocked: Story = {
  args: { link: LINK, copyState: "blocked" },
};

export const AfterExport: Story = { args: { link: null, highlight: true } };

export const NoMix: Story = {
  args: { noMix: { onRefresh: fn() } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Refresh mix" }),
    );
    await expect(args.noMix?.onRefresh).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  args: { link: LINK, share: true, compact: true, openedBy: OPENED_BY },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
