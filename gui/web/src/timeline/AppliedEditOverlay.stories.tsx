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
  operation: "approve_edits",
  source_start: 3.5,
  source_end: 4,
  params: { mute: true },
});
const second = appliedEditRecord({
  id: "second-edit",
  operation: "approve_edits",
  source_start: 6.5,
  source_end: 7,
  params: { mute: true },
});
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
    records: [visible, second],
    clips,
    trackId: "mira-voice",
    zoomPxPerSec: 40,
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
    const ticks = canvasElement.querySelectorAll(".applied-tick--mute");
    await expect(ticks).toHaveLength(4);
    await expect(ticks[0]).toHaveStyle({ left: "100px" });
  },
};

export const PhoneFiltered: Story = {
  parameters: { ...recordMobileViewport.parameters, phoneWidth: true },
  globals: recordMobileViewport.globals,
  args: { records: filtered },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".applied-tick")).toHaveLength(
      2,
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
