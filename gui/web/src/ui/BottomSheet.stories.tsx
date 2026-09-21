import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
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
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open sheet</Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Sheet content goes here — quick actions or the tablet/phone inspector.
        </p>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </BottomSheet>
    </>
  );
}

export const Default: Story = { render: () => <DemoSheet title="Inspector" /> };

export const Untitled: Story = { render: () => <DemoSheet /> };
