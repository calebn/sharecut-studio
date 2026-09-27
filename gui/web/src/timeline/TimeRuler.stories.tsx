import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { PlayheadNeedle } from "./PlayheadNeedle";
import { TimeRulerView } from "./TimeRulerView";

const meta: Meta<typeof TimeRulerView> = {
  title: "Templates/TimeRuler",
  component: TimeRulerView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    durationSec: 30,
    sessionDurationSec: 25,
    zoomPxPerSec: 24,
    valueSec: 8,
    getPlayheadSec: () => 8,
    visibleChunks: [0, 0],
    playhead: <PlayheadNeedle xPx={192} height="100%" />,
    onSeek: fn(),
    onFit: fn(),
    onCommentAnchor: fn(),
  },
  argTypes: {
    getPlayheadSec: { control: false, table: { disable: true } },
    visibleChunks: { control: false, table: { disable: true } },
    playhead: { control: false, table: { disable: true } },
  },
};

export default meta;
type Story = StoryObj<typeof TimeRulerView>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const slider = within(canvasElement).getByRole("slider", {
      name: "Timeline position",
    });
    await expect(slider).toHaveAttribute("aria-valuenow", "8");
    await expect(slider).toHaveAttribute("aria-valuemax", "25");
  },
};

export const PhoneWidth: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    durationSec: 9,
    sessionDurationSec: 9,
    zoomPxPerSec: 40,
    valueSec: 4,
    getPlayheadSec: () => 4,
    playhead: <PlayheadNeedle xPx={160} height="100%" />,
  },
  play: async ({ canvasElement }) => {
    const slider = within(canvasElement).getByRole("slider", {
      name: "Timeline position",
    });
    await expect(slider).toHaveStyle({ width: "360px" });
  },
};

export const CommentAnchor: Story = {
  args: {
    commentMode: true,
    valueSec: 5,
    getPlayheadSec: () => 5,
    playhead: <PlayheadNeedle xPx={120} height="100%" />,
  },
  play: async ({ canvasElement }) => {
    const slider = within(canvasElement).getByRole("slider", {
      name: "Comment time anchor",
    });
    await expect(slider).toHaveAttribute(
      "title",
      "Click for instant comment, drag for a span",
    );
    await expect(slider).toHaveAttribute("aria-valuenow", "5");
    const needle = slider.querySelector<HTMLElement>(".playhead");
    await expect(needle?.style.transform).toBe("translateX(120px)");
  },
};
