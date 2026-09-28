import type { Meta, StoryObj } from "@storybook/react-vite";
import { DialogLauncher } from "../test/DialogLauncher";
import { Button, Dialog } from "./index";

const meta: Meta<typeof Dialog> = {
  title: "Organisms/Dialog",
  component: Dialog,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Dialog>;

function DemoDialog({
  title,
  confirmVariant = "primary",
  confirmLabel = "Confirm",
}: {
  title: string;
  confirmVariant?: "primary" | "danger";
  confirmLabel?: string;
}) {
  return (
    <DialogLauncher label="Open dialog" initiallyOpen={false}>
      {(open, close) => (
        <Dialog open={open} onClose={close} title={title}>
          <p style={{ color: "var(--color-text-secondary)" }}>
            This is the modal dialog chrome: scrim, labelled panel, focus trap,
            and Escape to dismiss.
          </p>
          <div
            style={{
              display: "flex",
              gap: "var(--space-3)",
              justifyContent: "flex-end",
              marginTop: "var(--space-3)",
            }}
          >
            <Button onClick={close}>Cancel</Button>
            <Button variant={confirmVariant} onClick={close}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      )}
    </DialogLauncher>
  );
}

export const Default: Story = {
  render: () => <DemoDialog title="Confirm export" />,
};

export const Danger: Story = {
  render: () => (
    <DemoDialog
      title="Delete clip?"
      confirmVariant="danger"
      confirmLabel="Delete clip"
    />
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
