import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { GesturesSheet } from "./GesturesSheet";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open gestures",
    dialogName: "Gestures",
  });

function GesturesPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof GesturesSheet> & { initiallyOpen: boolean }) {
  return (
    <DialogLauncher label="Open gestures" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <GesturesSheet
          {...args}
          open={open}
          onClose={() => {
            close();
            args.onClose();
          }}
          onShowKeyboardShortcuts={() => {
            close();
            args.onShowKeyboardShortcuts();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof GesturesSheet> = {
  title: "Templates/GesturesSheet",
  component: GesturesSheet,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    onShowKeyboardShortcuts: fn(),
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <GesturesPreview {...args} initiallyOpen={context.viewMode === "story"} />
  ),
};

export default meta;
type Story = StoryObj<typeof GesturesSheet>;

export const Open: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText("Two-finger tap")).toBeVisible(),
    );
  },
};

export const KeyboardShortcutsHandoff: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Keyboard shortcuts" }),
    );
    await expect(args.onShowKeyboardShortcuts).toHaveBeenCalledOnce();
    await expect(within(document.body).queryByRole("dialog")).toBeNull();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await waitFor(() =>
      expect(within(dialog).getByText("Two-finger tap")).toBeVisible(),
    );
  },
};
