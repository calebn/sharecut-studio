import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { StageLoading } from "./StageLoading";

const meta: Meta<typeof StageLoading> = {
  title: "Stages/Frame/Loading",
  component: StageLoading,
  tags: ["autodocs"],
  args: {
    stage: "prepare",
    name: "Rosa and Maya",
    shell: "desktop",
    elapsedMs: 1000,
    onRetry: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Loading cover for a project on its way: nothing for 300 ms, then the Stage bar for real (the name is known from the URL or the Home card) over static grey placeholders in the destination stage\'s own layout, and after 4 s one line, "Still loading…" with a Retry button. No spinner, no "Loading" text. The stories fix the elapsed time; the app lets the timers run.',
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<typeof StageLoading>;

export const Blank: Story = {
  args: { elapsedMs: 100 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("tablist")).toBeNull();
  },
};

export const Prepare: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: /Prepare/, selected: true }),
    ).toBeVisible();
    const visibleLoading = canvas
      .queryAllByText(/Loading/)
      .filter((node) => !node.closest(".sr-only"));
    await expect(visibleLoading).toHaveLength(0);
    await expect(canvas.queryByRole("progressbar")).toBeNull();
  },
};

export const Review: Story = { args: { stage: "review" } };

async function checkEditLayout(canvasElement: HTMLElement) {
  const ruler = canvasElement.querySelector<HTMLElement>(
    ".stage-loading-block--ruler",
  );
  const lanes = Array.from(
    canvasElement.querySelectorAll<HTMLElement>(".stage-loading-block--lane"),
  );
  const script = canvasElement.querySelector<HTMLElement>(
    ".stage-loading-block--side",
  );
  const frame = canvasElement.querySelector<HTMLElement>(".stage-frame");
  if (!ruler || lanes.length !== 3 || !script || !frame) {
    throw new Error(
      "Edit loading skeleton is missing its timeline or Script blocks",
    );
  }

  const root = document.documentElement;
  const dark =
    root.dataset.theme === "dark" ||
    (root.dataset.theme !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const background = dark ? "rgb(19, 18, 17)" : "rgb(238, 241, 240)";
  const layout = frame.classList.contains("stage-frame--phone")
    ? "phone"
    : frame.clientWidth >=
        62.5 * Number.parseFloat(getComputedStyle(root).fontSize)
      ? "wide"
      : "stacked";

  const timeline = [ruler, ...lanes];
  const rects = timeline.map((block) => block.getBoundingClientRect());
  for (const [index, rect] of rects.entries()) {
    await expect(rect.width).toBeGreaterThan(0);
    if (index > 0) {
      await expect(rect.top).toBeGreaterThan(rects[index - 1].top);
      await expect(rect.left).toBeCloseTo(rects[0].left, 0);
      await expect(rect.width).toBeCloseTo(rects[0].width, 0);
    }
    const style = getComputedStyle(timeline[index]);
    await expect(style.backgroundColor).toBe(background);
    await expect(style.backgroundImage).toBe("none");
    await expect(style.animationName).toBe("none");
  }

  const scriptRect = script.getBoundingClientRect();
  const timelineBottom = rects[rects.length - 1].bottom;
  if (layout === "wide") {
    await expect(scriptRect.left).toBeGreaterThanOrEqual(rects[0].right);
    await expect(scriptRect.top).toBeLessThan(timelineBottom);
  } else if (layout === "stacked") {
    await expect(scriptRect.top).toBeGreaterThanOrEqual(timelineBottom);
  } else {
    await expect(script.getClientRects().length).toBe(0);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
  }
  const scriptStyle = getComputedStyle(script);
  await expect(scriptStyle.backgroundColor).toBe(background);
  await expect(scriptStyle.backgroundImage).toBe("none");
  await expect(scriptStyle.animationName).toBe("none");
}

export const Edit: Story = {
  args: { stage: "edit" },
  play: ({ canvasElement }) => checkEditLayout(canvasElement),
};

export const EditTablet: Story = {
  args: { stage: "edit", shell: "tablet" },
  globals: { viewport: { value: "tablet", isRotated: false } },
  play: ({ canvasElement }) => checkEditLayout(canvasElement),
};

export const EditPhone: Story = {
  args: { stage: "edit", shell: "phone" },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: ({ canvasElement }) => checkEditLayout(canvasElement),
};

export const EditDark: Story = {
  args: { stage: "edit" },
  globals: { theme: "dark", viewport: { value: "desktop", isRotated: false } },
  play: ({ canvasElement }) => checkEditLayout(canvasElement),
};

export const Deliver: Story = { args: { stage: "deliver" } };

export const Slow: Story = {
  args: { elapsedMs: 9000 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Still loading…")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  args: { shell: "phone", stage: "review" },
  globals: { viewport: { value: "phone", isRotated: false } },
};
