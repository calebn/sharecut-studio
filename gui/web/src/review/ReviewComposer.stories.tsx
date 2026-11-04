import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ComposerHarness } from "../storybook/ComposerHarness";
import { PhoneFrame } from "../storybook/ComposerHarness";
import {
  composerStoryMeta,
  storyParameters,
} from "../storybook/commentStoryMeta";
import { playInCanvas } from "../storybook/storyPlay";

const meta = {
  ...composerStoryMeta,
  title: "Stages/Review/Composer",
  parameters: storyParameters(
    "The Review comment field in its states. The anchor chip leads and pins on the first keystroke; Enter posts and Shift+Enter adds a line.\n\n**Motion.** Animations come later.",
  ),
} satisfies Meta<typeof ComposerHarness>;

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

export const EmptyingATypedPin: Story = {
  args: { anchor: { kind: "follow", seconds: 724 } },
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Comment" });
    await userEvent.type(field, "Hm");
    await expect(args.onAnchor).toHaveBeenCalledWith("pin");
    await expect(
      canvas.getByRole("button", {
        name: "Pinned at 12:04. Move to the playhead",
      }),
    ).toBeVisible();
    await userEvent.clear(field);
    await expect(
      canvas.getByRole("button", {
        name: "Comment at 12:04, follows the playhead. Pin it here",
      }),
    ).toBeVisible();
  }),
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
