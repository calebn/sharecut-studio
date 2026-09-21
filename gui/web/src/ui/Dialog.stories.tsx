import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button, Dialog } from "./index";

const meta: Meta<typeof Dialog> = {
  title: "Organisms/Dialog",
  component: Dialog,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Dialog>;

function DemoDialog({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        <p style={{ color: "var(--color-text-secondary)" }}>
          This is the modal dialog chrome: scrim, labelled panel, focus trap,
          and Escape to dismiss.
        </p>
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            justifyContent: "flex-end",
            marginTop: "var(--space-3)",
          }}
        >
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => setOpen(false)}>
            Confirm
          </Button>
        </div>
      </Dialog>
    </>
  );
}

export const Default: Story = {
  render: () => <DemoDialog title="Confirm export" />,
};

export const Danger: Story = {
  render: () => (
    <>
      <DemoDialog title="Delete clip?" />
    </>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Pair with `variant="danger"` buttons for destructive confirmations.',
      },
    },
  },
};
