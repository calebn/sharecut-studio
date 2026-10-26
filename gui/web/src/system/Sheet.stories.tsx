import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { Button } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import { Sheet } from "./Sheet";

const meta: Meta<typeof Sheet> = {
  title: "System/Sheet",
  component: Sheet,
  tags: ["autodocs"],
  args: { onClose: fn() },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "Every non-modal surface that is not a menu: header 40, rows (label left, control right), one primary in the footer. Anchored card 320, side panel 400, centered card 400 (wraps Dialog), and on phone a bottom sheet with Peek, Half and Full detents (wraps BottomSheet). Values apply as they change, so there is no Apply button. A pushed step replaces the body and the header keeps its title.\n\n**Motion.** Phone sheets slide with `--motion-panel` through BottomSheet; the pushed step slides in from the inline end with `--motion-panel`. Anchored and side frames are static in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Sheet>;

function Rows({ onMore }: { onMore?: () => void }) {
  return (
    <>
      <label className="sys-sheet-row">
        Gain
        <input
          type="range"
          min="0"
          max="10"
          defaultValue="5"
          aria-label="Gain"
        />
      </label>
      <label className="sys-sheet-row">
        Mute
        <input type="checkbox" aria-label="Mute track" />
      </label>
      {onMore ? (
        <button type="button" className="sys-text-btn" onClick={onMore}>
          Noise reduction
        </button>
      ) : null}
    </>
  );
}

const frame = {
  padding: "1rem",
  display: "flex",
  justifyContent: "center",
} as const;

export const Anchored: Story = {
  render: (args) => (
    <div style={frame}>
      <Sheet
        {...args}
        form="anchored"
        title="Clip"
        icon="sliders-horizontal"
        footer={<Button variant="primary">Done</Button>}
      >
        <Rows />
      </Sheet>
    </div>
  ),
};

export const SidePanel: Story = {
  render: (args) => (
    <div style={{ ...frame, blockSize: "24rem" }}>
      <Sheet {...args} form="side" title="Settings" icon="sliders-horizontal">
        <Rows />
      </Sheet>
    </div>
  ),
};

function Pushed(args: React.ComponentProps<typeof Sheet>) {
  const [step, setStep] = useState(false);
  return (
    <div style={frame}>
      <Sheet
        {...args}
        form="anchored"
        title="Clip"
        icon="sliders-horizontal"
        step={
          step
            ? {
                title: "Noise reduction",
                onBack: () => setStep(false),
                children: <Rows />,
              }
            : null
        }
      >
        <Rows onMore={() => setStep(true)} />
      </Sheet>
    </div>
  );
}

export const PushedStep: Story = {
  render: (args) => <Pushed {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Noise reduction" }),
    );
    await expect(
      canvas.getByRole("heading", { name: "Noise reduction" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(
      canvas.getByRole("button", { name: "Noise reduction" }),
    ).toBeVisible();
  },
};

export const Centered: Story = {
  parameters: isolatedStoryParameters,
  render: (args) => (
    <DialogLauncher label="Open join" initiallyOpen={false}>
      {(open, close) => (
        <Sheet
          {...args}
          form="centered"
          title="Join the room"
          open={open}
          onClose={close}
          footer={
            <Button variant="primary" onClick={close}>
              Join
            </Button>
          }
        >
          <Rows />
        </Sheet>
      )}
    </DialogLauncher>
  ),
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Open join",
      dialogName: "Join the room",
    });
  },
};

function PhoneSheet(args: React.ComponentProps<typeof Sheet>) {
  const [open, setOpen] = useState(false);
  const [detent, setDetent] = useState<DrawerDetent>("half");
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open mix</Button>
      <Sheet
        {...args}
        form="bottom"
        title="Mix"
        open={open}
        onClose={() => setOpen(false)}
        detent={detent}
        onDetentChange={setDetent}
        footer={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <Rows />
      </Sheet>
    </>
  );
}

export const Phone: Story = {
  parameters: isolatedStoryParameters,
  render: (args) => <PhoneSheet {...args} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    await openDialogByLauncher(canvasElement, {
      launcherName: "Open mix",
      dialogName: "Mix",
    });
  },
};
