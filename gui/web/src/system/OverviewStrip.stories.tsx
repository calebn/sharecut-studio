import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { OverviewStrip, type OverviewTick } from "./OverviewStrip";

const peaks = Array.from(
  { length: 64 },
  (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);

const ticks: OverviewTick[] = [
  { at: 0.12, kind: "suggestion" },
  { at: 0.3, kind: "comment" },
  { at: 0.44, kind: "find" },
  { at: 0.5, kind: "chapter" },
  { at: 0.71, kind: "suggestion", current: true },
  { at: 0.86, kind: "comment" },
];

const meta: Meta<typeof OverviewStrip> = {
  title: "System/OverviewStrip",
  component: OverviewStrip,
  tags: ["autodocs"],
  args: { peaks, label: "Episode overview", playhead: 0.4 },
  decorators: [
    (Story) => (
      <div style={{ padding: "1rem" }}>
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
          "A whole-episode miniature with the playhead, viewport, selection band and ticks. Four heights: 16 (phone Edit), 32 (Review context), 48 (Project card, static), 64 (expanded Player).\n\n**Motion.** The playhead and viewport follow with no easing while playing; the viewport eases with `--motion-state` when it jumps. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof OverviewStrip>;

export const Edit16: Story = {
  args: { height: 16, viewport: [0.3, 0.55], selection: [0.34, 0.4] },
  play: async ({ canvasElement }) => {
    const strip = within(canvasElement).getByRole("img", {
      name: "Episode overview",
    });
    await expect(strip).toHaveClass("sys-overview--16");
    await expect(
      strip.querySelector(".sys-overview-viewport")?.getAttribute("style"),
    ).toContain("30%");
    await expect(strip.querySelector(".sys-overview-selection")).not.toBeNull();
  },
};
export const Review32: Story = {
  args: { height: 32, ticks },
  play: async ({ canvasElement }) => {
    const strip = within(canvasElement).getByRole("img", {
      name: "Episode overview",
    });
    await expect(strip).toHaveClass("sys-overview--32");
    // Comments are dots; the other four ticks are lines, one of them current.
    await expect(strip.querySelectorAll(".sys-overview-dot")).toHaveLength(2);
    await expect(strip.querySelectorAll("line.sys-overview-tick")).toHaveLength(
      4,
    );
    await expect(strip.querySelectorAll(".is-current")).toHaveLength(1);
  },
};
export const CardStatic48: Story = {
  args: { height: 48, playhead: undefined },
  play: async ({ canvasElement }) => {
    const strip = within(canvasElement).getByRole("img", {
      name: "Episode overview",
    });
    await expect(strip).toHaveClass("sys-overview--48");
    await expect(strip.querySelector(".sys-overview-playhead")).toBeNull();
  },
};
export const Player64: Story = {
  args: { height: 64, ticks },
  play: async ({ canvasElement }) => {
    const strip = within(canvasElement).getByRole("img", {
      name: "Episode overview",
    });
    await expect(strip).toHaveClass("sys-overview--64");
    await expect(
      strip.querySelector(".sys-overview-playhead")?.getAttribute("style"),
    ).toContain("40%");
  },
};
