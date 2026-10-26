import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ToolModeToggleView } from "../../layout/ToolModeToggleView";
import { EditToolStripView } from "./EditToolStripView";

const meta: Meta<typeof EditToolStripView> = {
  title: "Stages/Edit/ToolStrip",
  component: EditToolStripView,
  args: {
    toolToggle: (
      <ToolModeToggleView
        toolMode="select"
        commentMode={false}
        selectTitle="Select tool (V)"
        bladeTitle="Blade tool (C)"
        commentTitle="Toggle comment mode"
        onSelect={fn()}
        onBlade={fn()}
        onToggleComment={fn()}
      />
    ),
    rangeArmed: false,
    rangeTitle: "Select a range",
    onToggleRange: fn(),
    showCut: false,
    cutTitle: "Cut selected tracks at playhead",
    onCut: fn(),
  },
  parameters: {
    docs: {
      description: {
        component:
          "Select / Blade, Comment mode and Select range in the timeline corner, over the track headers. The strip keeps today's tools until #2294 replaces them (Alt-click split, C for Comment, the Action bar); it adds no behaviour of its own.\n\n**Motion.** None: a pressed tool changes its chip in one frame.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof EditToolStripView>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Select range" }),
    );
    await expect(args.onToggleRange).toHaveBeenCalledOnce();
  },
};

export const RangeArmed: Story = {
  args: { rangeArmed: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Select range" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const BladeWithCut: Story = {
  args: { showCut: true },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Blade cut" }),
    );
    await expect(args.onCut).toHaveBeenCalledOnce();
  },
};

export const RangeUnavailable: Story = {
  args: { rangeReason: "Open a project to select a range" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Select range" }),
    ).toBeDisabled();
  },
};
