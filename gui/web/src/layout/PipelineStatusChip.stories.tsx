import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { pipelineJobSnapshot } from "../test/fixtures";
import { PipelineStatusChip } from "./PipelineStatusChip";

const meta: Meta<typeof PipelineStatusChip> = {
  title: "Templates/PipelineStatusChip",
  component: PipelineStatusChip,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story, context) =>
      context.parameters.mobileStatusChip ? (
        <main className="mobile-listen">
          <div className="mobile-status-chips">
            <Story />
          </div>
        </main>
      ) : (
        <>
          <main
            aria-label="Stage"
            style={{ blockSize: "var(--transport-height)" }}
          />
          <footer className="status-bar">
            <Story />
          </footer>
        </>
      ),
  ],
};

export default meta;
type Story = StoryObj<typeof PipelineStatusChip>;

export const Running: Story = {
  args: {
    job: pipelineJobSnapshot(),
    onClick: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", {
      name: /Pipeline: running · Preparing mix preview · 1\/3 steps/,
    });
    await expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};

export const MultipleActivities: Story = {
  args: {
    job: pipelineJobSnapshot({
      kind: "agent",
      message: "Scoring dialogue",
      current: null,
      total: null,
    }),
    runningCount: 3,
  },
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement)
      .getByText(/Activity: running/)
      .closest(".status-pipeline");
    await expect(chip).toHaveTextContent("3 activities");
    await expect(chip).toHaveAttribute("aria-busy", "true");
  },
};

export const Completed: Story = {
  args: {
    job: pipelineJobSnapshot({ status: "ok", current: 3, elapsed_sec: 41 }),
    onClick: fn(),
  },
};

export const Failed: Story = {
  args: {
    job: pipelineJobSnapshot({
      status: "error",
      message: "Mix preview failed",
      error: "Sample render error",
      elapsed_sec: 4,
    }),
    onClick: fn(),
  },
};

export const ReadOnly: Story = {
  args: {
    job: pipelineJobSnapshot({
      kind: "agent",
      status: "ok",
      message: "Transcript ready",
      current: null,
      total: null,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(
      canvas.getByText(/Activity: ok · Transcript ready/),
    ).toBeVisible();
  },
};

export const CompactPhone: Story = {
  args: {
    job: pipelineJobSnapshot({
      kind: "agent",
      message: "Scoring the dialogue alignment windows",
      current: null,
      total: null,
    }),
    runningCount: 3,
    headlineMax: 28,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    mobileStatusChip: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas
      .getByText(/Activity: running/)
      .closest(".status-pipeline");
    await expect(chip).toHaveTextContent("3 activities");
    await expect(chip).toHaveTextContent("…");
    await expect(chip).toHaveAttribute("aria-busy", "true");
  },
};
