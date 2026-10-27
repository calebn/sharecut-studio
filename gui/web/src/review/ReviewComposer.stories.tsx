import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ComposerHarness, PhoneFrame } from "../storybook/ComposerHarness";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { Composer } from "../system/Composer";

const meta: Meta<typeof ComposerHarness> = {
  title: "Stages/Review/Composer",
  component: Composer as never,
  render: (args) => <ComposerHarness {...args} />,
  tags: ["autodocs"],
  args: { onSubmit: fn(), onPinTime: fn(), onUnpinTime: fn() },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "30rem" }}>
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
          "The Review comment field in its states, restyled from the old comment compose. The time chip leads and pins on the first keystroke; Cmd or Ctrl+Enter posts.\n\n**Motion.** Animations come later.",
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
      "Lose the cough{Control>}{Enter}{/Control}",
    );
    await expect(args.onSubmit).toHaveBeenCalledOnce();
  }),
};

export const Anchored: Story = {
  args: { time: { seconds: 702.3, pinned: false } },
};

export const Posting: Story = {
  args: {
    time: { seconds: 702.3, pinned: true },
    start: "Lose the cough",
    state: "posting",
  },
};

export const Offline: Story = {
  args: {
    time: { seconds: 702.3, pinned: true },
    start: "Lose the cough",
    state: "offline",
  },
};

export const GuestFirstPost: Story = {
  args: {
    time: { seconds: 702.3, pinned: false },
    name: { value: "", onChange: fn(), required: true },
  },
};

export const Phone: Story = {
  args: { compact: true, time: { seconds: 702.3, pinned: false } },
  decorators: [
    (Story) => (
      <PhoneFrame>
        <Story />
      </PhoneFrame>
    ),
  ],
};
