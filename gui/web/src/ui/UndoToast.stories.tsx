import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { Button } from "./Button";
import { UndoToast, type UndoToastState } from "./UndoToast";

const MESSAGE = "Resolved comment at 00:12";

function UndoToastPreview(args: {
  onUndo: () => void;
  onDismiss: () => void;
  undoDisabled?: boolean;
}) {
  const [toast, setToast] = useState<UndoToastState | null>({
    id: 1,
    message: MESSAGE,
  });
  return (
    <main aria-label="Comments">
      <Button
        type="button"
        onClick={() =>
          setToast((current) => ({
            id: (current?.id ?? 0) + 1,
            message: MESSAGE,
          }))
        }
      >
        Show toast
      </Button>
      <UndoToast
        {...args}
        toast={toast}
        onUndo={() => {
          setToast(null);
          args.onUndo();
        }}
        onDismiss={() => {
          setToast(null);
          args.onDismiss();
        }}
      />
    </main>
  );
}

const meta: Meta<typeof UndoToast> = {
  title: "Molecules/UndoToast",
  component: UndoToast,
  tags: ["autodocs"],
  args: { toast: null, onUndo: fn(), onDismiss: fn() },
  argTypes: { toast: { control: false } },
  render: (args) => <UndoToastPreview {...args} />,
};

export default meta;
type Story = StoryObj<typeof UndoToast>;

export const Shown: Story = {
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(MESSAGE));
  },
};

export const UndoAndDismiss: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(MESSAGE));
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await expect(args.onUndo).toHaveBeenCalledOnce();
    await waitFor(() => expect(status).toHaveTextContent(""));

    await userEvent.click(canvas.getByRole("button", { name: "Show toast" }));
    await waitFor(() => expect(status).toHaveTextContent(MESSAGE));
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss" }));
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};

export const UndoUnavailable: Story = {
  args: { undoDisabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(MESSAGE));
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeDisabled();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(MESSAGE));
  },
};
