import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ComposerHarness } from "../storybook/ComposerHarness";
import {
  columnStoryDecorator,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { playInCanvas } from "../storybook/storyPlay";
import { Composer } from "./Composer";

const meta: Meta<typeof ComposerHarness> = {
  title: "System/Composer",
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
          "The one comment field, props only. The anchor chip leads inside the field and pins on the first keystroke. Tap the chip to move it to the playhead or the selection, and clear it for a whole-episode note. Enter posts and Shift+Enter adds a line; on a phone Return adds a line and the arrow posts. Post stays off until there is text and the control says why. A guest's name is optional, and a blank name posts as Guest. Offline, the arrow is named Queue comment and shows the offline glyph.\n\n**Motion.** Animations come later: the chip settles when it pins.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ComposerHarness>;

export const Empty: Story = {};

export const Anchored: Story = {
  args: { anchor: { kind: "follow", seconds: 724 } },
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Comment" }),
      "Hm",
    );
    await expect(args.onAnchor).toHaveBeenCalledWith("pin");
    await userEvent.click(canvas.getByRole("button", { name: /^Pinned at/ }));
    await expect(args.onAnchor).toHaveBeenLastCalledWith("here");
  }),
};

export const Pinned: Story = {
  args: { anchor: { kind: "pinned", start: 724 }, start: "Cough here" },
};

export const Selection: Story = {
  args: {
    anchor: { kind: "pinned", start: 724, end: 729 },
    start: "Cough here",
  },
};

export const WholeEpisode: Story = {
  args: { anchor: { kind: "episode" }, start: "Great episode" },
};

export const Posting: Story = {
  args: { start: "Cough here", state: "posting" },
};

export const Offline: Story = {
  args: { start: "Cough here", state: "offline" },
};

export const GuestFirstPost: Story = {
  args: {
    name: { value: "", onChange: fn() },
    start: "Cough here",
  },
};

export const HeldEnterAfterName: Story = {
  args: {
    name: { value: "Rosa", onChange: fn() },
    start: "Cough here",
  },
  play: playInCanvas(async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const body = canvas.getByRole("textbox", { name: "Comment" });
    await userEvent.click(canvas.getByRole("textbox", { name: "Your name" }));
    await userEvent.keyboard("{Enter}");
    await expect(body).toHaveFocus();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        repeat: true,
      }),
    );
    await expect(body).toHaveFocus();
    await expect(args.onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect(args.onSubmit).toHaveBeenCalledTimes(1);
    await expect(body).toHaveValue("");
  }),
};

export const Compact: Story = {
  args: { compact: true, anchor: { kind: "pinned", start: 724 } },
};
