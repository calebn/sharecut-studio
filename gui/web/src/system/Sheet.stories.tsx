import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import { Button, ToggleButton } from "../ui";
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
          "Every non-modal surface that is not a menu: header 40, rows (label left, control right), one primary in the footer. Anchored card 320, side panel 400, centered card 400 (wraps Dialog), and on phone a bottom sheet with Peek, Half and Full detents (wraps BottomSheet). Values apply as they change, so there is no Apply button. A pushed step replaces the body: in the static frames the header shows Back (an icon button) and the step's title; in the Dialog and BottomSheet forms the title changes and Back sits at the top of the body. The phone footer is one primary, 48 tall and full width, at the bottom of the sheet whatever the pointer. The Expand and Collapse buttons on the phone header belong to `BottomSheet` and stay text until that component is touched.\n\n**Motion.** Phone sheets slide with `--motion-panel` through BottomSheet; the pushed step slides in from the inline end with `--motion-panel`. Anchored and side frames are static in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Sheet>;

function Rows({ onMore }: { onMore?: () => void }) {
  const [gain, setGain] = useState(0);
  const [muted, setMuted] = useState(false);
  return (
    <>
      <div className="sys-sheet-row">
        <span>Gain {gain > 0 ? `+${gain}` : gain} dB</span>
        <span style={{ display: "flex", gap: "var(--space-3)" }}>
          <Button onClick={() => setGain((g) => g - 1)}>Lower gain</Button>
          <Button onClick={() => setGain((g) => g + 1)}>Raise gain</Button>
        </span>
      </div>
      <div className="sys-sheet-row">
        <span>Track</span>
        <ToggleButton pressed={muted} onClick={() => setMuted((m) => !m)}>
          Mute
        </ToggleButton>
      </div>
      {onMore ? (
        <button type="button" className="sys-text-btn" onClick={onMore}>
          Noise reduction
        </button>
      ) : null}
    </>
  );
}

const frame = {
  padding: "var(--space-5)",
  display: "flex",
  justifyContent: "center",
} as const;

export const AnchoredCard: Story = {
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
    const step = canvas.getByRole("heading", { name: "Noise reduction" });
    await expect(step).toBeVisible();
    await expect(step).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    const parent = canvas.getByRole("heading", { name: "Clip" });
    await expect(parent).toBeVisible();
    await expect(parent).toHaveFocus();
    await expect(
      canvas.getByRole("button", { name: "Noise reduction" }),
    ).toBeVisible();
  },
};

function PushedOverlay({
  form,
  ...args
}: React.ComponentProps<typeof Sheet> & { form: "centered" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open sheet</Button>
      <Sheet
        {...args}
        form={form}
        title="Clip"
        open={open}
        onClose={close}
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
    </>
  );
}

/** The overlay hook takes focus back to Close on the frame after a title change, so a check made at once misses it. */
function nextFrames(count: number) {
  return new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(count);
  });
}

function pushedOverlayStory(form: "centered" | "bottom"): Story {
  return {
    parameters: isolatedStoryParameters,
    render: (args) => <PushedOverlay {...args} form={form} />,
    play: async ({ canvasElement, viewMode }) => {
      if (viewMode === "docs") return;
      const dialog = await openDialogByLauncher(canvasElement, {
        launcherName: "Open sheet",
        dialogName: "Clip",
      });
      const inside = within(dialog);
      await userEvent.click(
        inside.getByRole("button", { name: "Noise reduction" }),
      );
      // The body is replaced, so focus goes to the step's first control: Back.
      await waitFor(() =>
        expect(inside.getByRole("button", { name: "Back" })).toHaveFocus(),
      );
      await nextFrames(2);
      await expect(inside.getByRole("button", { name: "Back" })).toHaveFocus();
      await userEvent.click(inside.getByRole("button", { name: "Back" }));
      await waitFor(() =>
        expect(
          inside.getByRole("button", { name: "Lower gain" }),
        ).toHaveFocus(),
      );
      await nextFrames(2);
      await expect(
        inside.getByRole("button", { name: "Lower gain" }),
      ).toHaveFocus();
    },
  };
}

/** The Dialog form: Back sits at the top of the body and takes focus on push. */
export const CenteredPushedStep: Story = pushedOverlayStory("centered");
/** The BottomSheet form: same body, same focus handoff. */
export const PhonePushedStep: Story = pushedOverlayStory("bottom");

export const CenteredCard: Story = {
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

function PhoneSheet({
  startAt,
  ...args
}: React.ComponentProps<typeof Sheet> & { startAt: DrawerDetent }) {
  const [open, setOpen] = useState(false);
  const [detent, setDetent] = useState<DrawerDetent>(startAt);
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

function phoneStory(startAt: DrawerDetent): Story {
  return {
    parameters: isolatedStoryParameters,
    render: (args) => <PhoneSheet {...args} startAt={startAt} />,
    play: async ({ canvasElement, viewMode }) => {
      if (viewMode === "docs") return;
      const dialog = await openDialogByLauncher(canvasElement, {
        launcherName: "Open mix",
        dialogName: "Mix",
      });
      // The footer is the phone form's own; its 48 px full-width primary is
      // measured in the browser sweep (e2e-storybook/system.spec.ts).
      const done = within(dialog).getByRole("button", { name: "Done" });
      await expect(
        done.closest(".sys-sheet-bottom .sys-sheet-footer"),
      ).not.toBeNull();
    },
  };
}

export const PhonePeek: Story = phoneStory("peek");
export const PhoneHalf: Story = phoneStory("half");
export const PhoneFull: Story = phoneStory("full");
