import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { GesturesSheet } from "./GesturesSheet";

const meta: Meta<typeof GesturesSheet> = {
  title: "Templates/GesturesSheet",
  component: GesturesSheet,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    onShowKeyboardShortcuts: fn(),
  },
  decorators: [
    (Story) => (
      <main aria-label="Studio backdrop">
        <Story />
      </main>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof GesturesSheet>;

export const Open: Story = {
  play: async ({ args }) => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Gestures",
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keyboard shortcuts" }),
    );
    await expect(args.onShowKeyboardShortcuts).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Gestures",
    });
    await expect(within(dialog).getByText("Two-finger tap")).toBeVisible();
  },
};
