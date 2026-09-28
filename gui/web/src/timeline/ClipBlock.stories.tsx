import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { clipRow } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { ClipBlockView } from "./ClipBlockView";
import { clipBlockGeometry } from "./clipBlockGeometry";
import { laneColor } from "./laneColors";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const geometry = (
  clip: ClipRow,
  previews: Partial<Parameters<typeof clipBlockGeometry>[0]> = {},
) =>
  clipBlockGeometry({
    clip,
    zoomPxPerSec: 40,
    rollPreview: null,
    trimPreview: null,
    fadePreview: null,
    previewTimelineStart: null,
    ...previews,
  });

const prev = clipRow({
  id: "story-clip-1",
  source_start: 0,
  source_end: 4,
  timeline_start: 0,
  timeline_end: 4,
});
const clip = clipRow({
  id: "story-clip-2",
  source_start: 5,
  source_end: 12,
  timeline_start: 4,
  timeline_end: 11,
  fade_in_ms: 300,
  fade_out_ms: 0,
  mute_regions: [{ start_s: 7, end_s: 8 }],
  clipping_regions: [{ start_s: 10, end_s: 10.4 }],
});

const meta: Meta<typeof ClipBlockView> = {
  title: "Templates/ClipBlock",
  component: ClipBlockView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", lanePreviewLabel: "Clip preview" },
  decorators: [timelineLaneStoryDecorator],
  argTypes: {
    geometry: { control: false, table: { disable: true } },
    waveform: { control: false, table: { disable: true } },
    ghostWaveform: { control: false, table: { disable: true } },
    hitHandlers: { control: false, table: { disable: true } },
  },
  args: {
    clip,
    role: "dialogue",
    zoomPxPerSec: 40,
    color: laneColor("dialogue", 0),
    selected: false,
    geometry: geometry(clip),
    prevClip: prev,
    nextClip: null,
    showHandles: true,
    canMove: true,
    snapTicks: [],
    hitHandlers: { onClick: fn() },
    onHandlePointerDown: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ClipBlockView>;

export const Editable: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", {
      name: "Select clip story-clip-2",
    });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(canvasElement.querySelectorAll(".trim-handle")).toHaveLength(
      2,
    );
    await expect(
      canvasElement.querySelector(".clip-mute-region"),
    ).not.toBeNull();
    await expect(
      canvasElement.querySelector(".clip-clipping-region"),
    ).not.toBeNull();
    await userEvent.click(button);
    await expect(args.hitHandlers?.onClick).toHaveBeenCalled();
  },
};

export const SelectedCrossfadeJoin: Story = {
  args: {
    selected: true,
    clip: { ...clip, join_in_mode: "crossfade" },
    geometry: geometry({ ...clip, join_in_mode: "crossfade" }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".clip-block.selected.join-crossfade"),
    ).not.toBeNull();
  },
};

export const TrimPreview: Story = {
  args: {
    geometry: geometry(clip, {
      trimPreview: { edge: "out", sourceStart: 5, sourceEnd: 13.5 },
    }),
    snapTicks: [13.5],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".clip-block.trim-dragging"),
    ).not.toBeNull();
    const ghost = canvasElement.querySelector(
      ".clip-trim-ghost",
    ) as HTMLElement;
    await expect(ghost).toHaveStyle({ width: "60px" });
  },
};

export const FadeReadout: Story = {
  args: {
    geometry: geometry(clip, {
      fadePreview: { edge: "in", inMs: 600, outMs: 0 },
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".fade-readout.in"),
    ).toHaveTextContent("600 ms");
  },
};

export const ReadOnly: Story = {
  args: { showHandles: false, canMove: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".trim-handle")).toHaveLength(
      0,
    );
    await expect(
      canvasElement.querySelector("span.join-diamond"),
    ).not.toBeNull();
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { trackLabel: "Mira" },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".clip-label-track"),
    ).toHaveTextContent("Mira");
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};
