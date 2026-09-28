import type { Meta, StoryObj } from "@storybook/react-vite";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { BottomSheet, Button } from "./index";

const meta: Meta<typeof BottomSheet> = {
  title: "Organisms/BottomSheet",
  component: BottomSheet,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Transient bottom sheet for phone/tablet inspector and quick actions. " +
          "Preview at a narrow viewport to see its intended context.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof BottomSheet>;

function DemoSheet({ title }: { title?: string }) {
  return (
    <DialogLauncher label="Open sheet" initiallyOpen={false}>
      {(open, close) => (
        <BottomSheet open={open} onClose={close} title={title}>
          <p style={{ color: "var(--color-text-secondary)" }}>
            Sheet content goes here — quick actions or the tablet/phone
            inspector.
          </p>
          <Button onClick={close}>Done</Button>
        </BottomSheet>
      )}
    </DialogLauncher>
  );
}

export const Default: Story = {
  render: () => <DemoSheet title="Inspector" />,
  play: async ({ canvasElement }) => {
    await openDialogByLauncher(canvasElement, {
      launcherName: "Open sheet",
      dialogName: "Inspector",
    });
  },
};

export const Untitled: Story = { render: () => <DemoSheet /> };
