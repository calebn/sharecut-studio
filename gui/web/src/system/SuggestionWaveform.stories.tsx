import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  fillerPeaks,
  pausePeaks,
  windowPeaks,
} from "../storybook/reviewFixtures";
import { viewportStoryParameters } from "../storybook/storyLayout";
import {
  SuggestionWaveform,
  type SuggestionWaveformProps,
} from "./SuggestionWaveform";
import type { TimeRange } from "./seconds";

function Adjustable(props: SuggestionWaveformProps) {
  const [range, setRange] = useState({ start: props.start, end: props.end });
  return (
    <SuggestionWaveform
      {...props}
      {...range}
      onAdjust={(next: TimeRange) => {
        setRange(next);
        props.onAdjust?.(next);
      }}
    />
  );
}

const meta: Meta<typeof SuggestionWaveform> = {
  title: "System/SuggestionWaveform",
  component: SuggestionWaveform,
  tags: ["autodocs"],
  args: {
    icon: "scissors",
    peaks: fillerPeaks,
    windowStart: 1110,
    start: 1114.4,
    end: 1115.2,
    onAdjust: fn(),
    onAdjustStart: fn(),
  },
  render: (args) => <Adjustable {...args} />,
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The 96 px waveform of one suggestion, 6 s either side. The proposed range is hatched with a 2 px outline and a kind glyph. Each edge has a 12 px handle with a 44 px hit area; drag it or use the arrow keys (Shift for 0.5 s). Dragging snaps to silence from the peaks, and Alt moves freely. A guest sees the range and cannot move it.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SuggestionWaveform>;

export const Filler: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Start of the change" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("slider", { name: "End of the change" }),
    ).toBeVisible();
  },
};

export const Pause: Story = {
  args: {
    icon: "fold-horizontal",
    peaks: pausePeaks,
    start: 1114.3,
    end: 1117.2,
  },
};

export const Sound: Story = {
  args: { icon: "volume-1", start: 1113, end: 1116 },
};

/** Keyboard moves the handle; onAdjustStart fires first. */
export const Adjusting: Story = {
  play: async ({ args, canvasElement }) => {
    const handle = within(canvasElement).getByRole("slider", {
      name: "End of the change",
    });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(args.onAdjustStart).toHaveBeenCalled();
    await expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(
      before,
    );
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole("slider", {
      name: "End of the change",
    });
    await expect(handle).toHaveAttribute("aria-readonly", "true");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
  },
};

export const Silent: Story = {
  args: { peaks: windowPeaks([[0, 12]]) },
};

export const Phone: Story = {};
