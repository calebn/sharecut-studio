import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ComposerHarness } from "../storybook/ComposerHarness";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { Composer } from "./Composer";

const meta: Meta<typeof ComposerHarness> = {
  title: "System/Composer",
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
          "The one comment field, props only. The time chip leads inside the field and pins on the first keystroke; click the pinned chip to follow the playhead again. Cmd or Ctrl+Enter posts. Post stays off until there is text (and a name, when a guest must give one) and the control says why. Offline, the label is Queue comment with the offline glyph. A viewer sees the field read-only with the reason beneath it.\n\n**Motion.** Animations come later: the chip settles when it pins.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ComposerHarness>;

export const Empty: Story = {};

export const Anchored: Story = {
  args: { time: { seconds: 702.3, pinned: false } },
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Comment" }),
      "Hm",
    );
    await expect(args.onPinTime).toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: /Pinned at/ }));
    await expect(args.onUnpinTime).toHaveBeenCalledOnce();
  }),
};

export const Pinned: Story = {
  args: { time: { seconds: 702.3, pinned: true }, start: "Cough here" },
};

export const Posting: Story = {
  args: { start: "Cough here", state: "posting" },
};

export const Offline: Story = {
  args: { start: "Cough here", state: "offline" },
};

export const GuestFirstPost: Story = {
  args: {
    name: { value: "", onChange: fn(), required: true },
    start: "Cough here",
  },
};

export const ReadOnly: Story = {
  args: { disabledReason: "Viewers can read comments, not write them." },
};

export const Compact: Story = {
  args: { compact: true, time: { seconds: 702.3, pinned: true } },
};
