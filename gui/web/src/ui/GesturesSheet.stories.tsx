import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ComponentProps, useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { Button } from "./Button";
import { GesturesSheet } from "./GesturesSheet";

function GesturesPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof GesturesSheet> & { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Open gestures
      </Button>
      <GesturesSheet
        {...args}
        open={open}
        onClose={() => {
          setOpen(false);
          args.onClose();
        }}
        onShowKeyboardShortcuts={() => {
          setOpen(false);
          args.onShowKeyboardShortcuts();
        }}
      />
    </>
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
    if (!within(document.body).queryByRole("dialog")) {
      await userEvent.click(
        within(canvasElement).getByRole("button", { name: "Open gestures" }),
      );
    }
    const dialog = within(document.body).getByRole("dialog", {
      name: "Gestures",
    });
    await waitFor(() =>
      expect(within(dialog).getByText("Two-finger tap")).toBeVisible(),
    );
  },
};

export const KeyboardShortcutsHandoff: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    if (!within(document.body).queryByRole("dialog")) {
      await userEvent.click(
        within(canvasElement).getByRole("button", { name: "Open gestures" }),
      );
    }
    const dialog = within(document.body).getByRole("dialog", {
      name: "Gestures",
    });
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
    if (!within(document.body).queryByRole("dialog")) {
      await userEvent.click(
        within(canvasElement).getByRole("button", { name: "Open gestures" }),
      );
    }
    const dialog = within(document.body).getByRole("dialog", {
      name: "Gestures",
    });
    await waitFor(() =>
      expect(within(dialog).getByText("Two-finger tap")).toBeVisible(),
    );
  },
};
