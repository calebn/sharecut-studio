import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { appliedEditRecord, clipRow } from "../test/fixtures";
import { AppliedEditOverlay } from "./AppliedEditOverlay";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const clips = [
  clipRow({
    id: "c1",
    source_start: 0,
    source_end: 2,
    timeline_start: 0,
    timeline_end: 2,
  }),
  clipRow({
    id: "c2",
    source_start: 3,
    source_end: 5,
    timeline_start: 2,
    timeline_end: 5,
  }),
  clipRow({
    id: "c3",
    source_start: 6,
    source_end: 9,
    timeline_start: 5,
    timeline_end: 8,
  }),
];

const visible = appliedEditRecord({
  id: "visible-edit",
  operation: "ripple_delete",
  timeline_start: 2,
  timeline_end: 3,
  source_start: null,
  source_end: null,
  params: { per_track_source: { "mira-voice": [2, 3] } },
});
const selected = appliedEditRecord({
  id: "selected-edit",
  operation: "remove",
  timeline_start: 5,
  timeline_end: 6,
  source_start: 5,
  source_end: 6,
  reason: "Keep the entrance tight",
});
// A contiguous 5-clip chain (source and timeline both 0-5) so each record's
// [i+1, i+1] pair matches one clip's source_end and the next clip's
// source_start, giving one seam per boundary.
const denseSeamClips = [0, 1, 2, 3, 4].map((index) =>
  clipRow({
    id: `dense-clip-${index}`,
    source_start: index,
    source_end: index + 1,
    timeline_start: index,
    timeline_end: index + 1,
  }),
);
const dense = [0, 1, 2, 3].map((index) =>
  appliedEditRecord({
    id: `dense-edit-${index}`,
    operation: "ripple_delete",
    timeline_start: index + 1,
    timeline_end: index + 1,
    source_start: null,
    source_end: null,
    params: {
      per_track_source: {
        "mira-voice": [index + 1, index + 1],
      },
    },
  }),
);
const filtered = [
  visible,
  appliedEditRecord({ id: "other-track", track_ids: ["ari-voice"] }),
  appliedEditRecord({
    id: "unmapped",
    timeline_start: null,
    timeline_end: null,
    source_start: null,
    source_end: null,
  }),
];

const meta: Meta<typeof AppliedEditOverlay> = {
  title: "Templates/AppliedEditOverlay",
  component: AppliedEditOverlay,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    lanePreviewLabel: "Applied edit marker preview",
  },
  decorators: [timelineLaneStoryDecorator],
  args: {
    records: [visible, selected],
    clips,
    trackId: "mira-voice",
    zoomPxPerSec: 40,
    selectedId: null,
  },
};

export default meta;
type Story = StoryObj<typeof AppliedEditOverlay>;

export const Visible: Story = {
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("main")).toHaveAttribute(
      "aria-label",
      "Applied edit marker preview",
    );
    const ticks = canvasElement.querySelectorAll(".applied-tick--seam");
    await expect(ticks).toHaveLength(2);
    await expect(ticks[0]).toHaveStyle({ left: "80px" });
  },
};

export const Selected: Story = {
  args: { selectedId: selected.id },
  play: async ({ canvasElement }) => {
    const ticks = canvasElement.querySelectorAll(".applied-tick.selected");
    await expect(ticks).toHaveLength(1);
  },
};

export const DenseSeams: Story = {
  args: { records: dense, clips: denseSeamClips },
  play: async ({ canvasElement }) => {
    const ticks = canvasElement.querySelectorAll(".applied-tick");
    await expect(ticks).toHaveLength(4);
    for (const tick of ticks) {
      await expect(tick).not.toHaveAttribute("width");
    }
  },
};

export const PhoneFiltered: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { records: filtered },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".applied-tick")).toHaveLength(
      1,
    );
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};

export const PhoneEmpty: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { records: filtered, trackId: "no-edits" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".applied-tick")).toHaveLength(
      0,
    );
    await expect(canvasElement.querySelector(".lane-row")).toHaveStyle({
      width: "360px",
    });
  },
};

export const Unmapped: Story = {
  args: {
    records: [
      appliedEditRecord({
        id: "legacy",
        operation: "ripple_delete",
        timeline_start: 0,
        timeline_end: 1334.8,
        source_start: null,
        source_end: null,
        params: {},
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".applied-tick")).toHaveLength(
      0,
    );
    await expect(canvasElement.querySelector(".applied-edit-layer")).toBeNull();
  },
};
