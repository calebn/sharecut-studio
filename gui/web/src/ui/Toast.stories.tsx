import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { Button } from "./Button";
import { Toast, type ToastState } from "./Toast";

const MESSAGE = "Resolved comment at 00:12";

function ToastPreview({
  message = MESSAGE,
  ...args
}: {
  onUndo?: () => void;
  onDismiss: () => void;
  undoDisabled?: boolean;
  message?: string;
}) {
  const [toast, setToast] = useState<ToastState | null>({ id: 1, message });
  return (
    <main aria-label="Comments">
      <Button
        type="button"
        onClick={() =>
          setToast((current) => ({
            id: (current?.id ?? 0) + 1,
            message,
          }))
        }
      >
        Show toast
      </Button>
      <Toast
        {...args}
        toast={toast}
        onUndo={
          args.onUndo
            ? () => {
                setToast(null);
                args.onUndo?.();
              }
            : undefined
        }
        onDismiss={() => {
          setToast(null);
          args.onDismiss();
        }}
      />
    </main>
  );
}

const meta: Meta<typeof Toast> = {
  title: "Molecules/Toast",
  component: Toast,
  tags: ["autodocs"],
  args: { toast: null, onUndo: fn(), onDismiss: fn() },
  argTypes: { toast: { control: false } },
  render: (args) => <ToastPreview {...args} />,
};

export default meta;
type Story = StoryObj<typeof Toast>;

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

export const WithoutUndo: Story = {
  render: (args) => (
    <ToastPreview onDismiss={args.onDismiss} message="Guest link copied" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Guest link copied"));
    await expect(canvas.queryByRole("button", { name: "Undo" })).toBeNull();
  },
};
