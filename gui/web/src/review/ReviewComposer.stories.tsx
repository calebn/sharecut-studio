import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ComposerHarness, PhoneFrame } from "../storybook/ComposerHarness";
import {
  columnStoryDecorator,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { Composer } from "../system/Composer";

const meta: Meta<typeof ComposerHarness> = {
  title: "Stages/Review/Composer",
  component: Composer as never,
  render: (args) => <ComposerHarness {...args} />,
  tags: ["autodocs"],
  args: { onSubmit: fn(), onAnchor: fn() },
  decorators: [columnStoryDecorator],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Review comment field in its states. The anchor chip leads and pins on the first keystroke; Enter posts and Shift+Enter adds a line.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ComposerHarness>;

export const Empty: Story = {
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Post" })).toBeDisabled();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Comment" }),
      "Lose the cough{Enter}",
    );
    await expect(args.onSubmit).toHaveBeenCalledOnce();
  }),
};

export const Anchored: Story = {
  args: { anchor: { kind: "follow", seconds: 724 } },
};

export const Posting: Story = {
  args: {
    anchor: { kind: "pinned", start: 724 },
    start: "Lose the cough",
    state: "posting",
  },
};

export const Offline: Story = {
  args: {
    anchor: { kind: "pinned", start: 724 },
    start: "Lose the cough",
    state: "offline",
  },
};

export const GuestFirstPost: Story = {
  args: {
    anchor: { kind: "follow", seconds: 724 },
    name: { value: "", onChange: fn() },
  },
};

export const Selection: Story = {
  args: { anchor: { kind: "pinned", start: 724, end: 729 } },
};

export const WholeEpisode: Story = {
  args: { anchor: { kind: "episode" } },
};

export const Phone: Story = {
  args: { compact: true, anchor: { kind: "follow", seconds: 724 } },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};
