import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  type BleedAttenuationRegion,
  bleedAttenuationRegionKey,
} from "../edit/bleedAttenuation";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { BleedAttenuationOverlay } from "./BleedAttenuationOverlay";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const region: BleedAttenuationRegion<{ seal: string }> = {
  trackId: "mira",
  occurrenceId: "synthetic-copy",
  kind: "late_gate",
  sourceSpan: { start: 20, end: 21 },
  timelineSpan: { start: 5, end: 6 },
  restore: {
    state: "available",
    target: { seal: "synthetic-target" },
    sourceSpan: { start: 20, end: 21 },
  },
};
const Overlay = BleedAttenuationOverlay<{ seal: string }>;
const meta: Meta<typeof Overlay> = {
  title: "Templates/BleedAttenuationOverlay",
  component: Overlay,
  parameters: {
    ...isolatedStoryParameters,
    layout: "fullscreen",
    lanePreviewLabel: "Synthetic automatic reduction regions",
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    regions: [
      { region, leftPx: 40, widthPx: 180 },
      {
        region: {
          ...region,
          kind: "bleed_mute:off_speaker",
          sourceSpan: { start: 22, end: 23 },
          timelineSpan: { start: 7, end: 8 },
        },
        leftPx: 260,
        widthPx: 180,
      },
    ],
    selectedKey: bleedAttenuationRegionKey(region),
    onSelect: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof Overlay>;
export const SelectableRegions: Story = {
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole("button", {
      name: /^Automatic reduction,/,
    });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button);
    await expect(args.onSelect).toHaveBeenCalledWith(
      bleedAttenuationRegionKey(region),
    );
  },
};
export const BriefRegion: Story = {
  args: { regions: [{ region, leftPx: 120, widthPx: 1 }] },
};
export const Empty: Story = { args: { regions: [] } };

export const PhoneWidth: Story = {
  parameters: { phoneWidth: true },
  args: {
    regions: [
      { region, leftPx: 16, widthPx: 156 },
      {
        region: {
          ...region,
          kind: "bleed_mute:off_speaker",
          sourceSpan: { start: 22, end: 23 },
          timelineSpan: { start: 7, end: 8 },
        },
        leftPx: 188,
        widthPx: 156,
      },
    ],
  },
};
