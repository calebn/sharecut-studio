import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { appliedEditRecord } from "../test/fixtures";
import { AppliedEditOverlay } from "./AppliedEditOverlay";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const visible = appliedEditRecord({
  id: "visible-edit",
  timeline_start: 2,
  timeline_end: 3,
});
const selected = appliedEditRecord({
  id: "selected-edit",
  timeline_start: 5,
  timeline_end: 6,
  reason: "Keep the entrance tight",
});
const dense = [0, 1, 2, 3].map((index) =>
  appliedEditRecord({
    id: `dense-edit-${index}`,
    timeline_start: 2 + index * 0.12,
    timeline_end: 2.03 + index * 0.12,
  }),
);
const filtered = [
  visible,
  appliedEditRecord({ id: "other-track", track_ids: ["ari-voice"] }),
  appliedEditRecord({
    id: "unmapped",
    timeline_start: null,
    timeline_end: null,
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
    trackId: "mira-voice",
    zoomPxPerSec: 40,
    selectedId: null,
    onSelect: fn(),
  },
  argTypes: {
    onSelect: { control: false, table: { disable: true } },
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
    const ticks = canvasElement.querySelectorAll(".applied-tick");
    await expect(ticks).toHaveLength(2);
    await expect(ticks[0]).toHaveStyle({ left: "80px", width: "40px" });
  },
};

export const Selected: Story = {
  args: { selectedId: selected.id },
  play: async ({ canvasElement }) => {
    const tick = canvasElement.querySelector(".applied-tick.selected");
    await expect(tick).toHaveAttribute(
      "title",
      "remove: Keep the entrance tight",
    );
  },
};

export const DenseShortCuts: Story = {
  args: { records: dense },
  play: async ({ canvasElement }) => {
    const ticks = canvasElement.querySelectorAll(".applied-tick");
    await expect(ticks).toHaveLength(4);
    for (const tick of ticks) {
      await expect(tick).toHaveStyle({ width: "3px" });
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
