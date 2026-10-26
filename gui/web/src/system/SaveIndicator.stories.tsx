import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { SaveIndicator } from "./SaveIndicator";

const meta: Meta<typeof SaveIndicator> = {
  title: "System/SaveIndicator",
  component: SaveIndicator,
  tags: ["autodocs"],
  args: { state: "saved", onRetry: fn(), onDownload: fn() },
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
          "A small glyph after the title. Saved shows nothing, or a check for 2 s after a save. Saving is a hollow ring, Offline an amber cloud with a count, Failed a red octagon with Retry and Download a copy. Every state also has a text name for assistive tech.\n\n**Motion.** The check fades out after 2 s with `--motion-state` in the animation pass; the 2 s hold is the caller's.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SaveIndicator>;

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved");
    await expect(status.querySelector("svg")).toBeNull();
  },
};
export const JustSaved: Story = {
  args: { justSaved: true },
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status");
    await expect(status).toHaveTextContent("Saved");
    await expect(status.querySelector("svg")).not.toBeNull();
  },
};
export const Saving: Story = {
  args: { state: "saving" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Saving",
    );
  },
};
export const Offline: Story = {
  args: { state: "offline", waiting: 2 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "2 waiting",
    );
  },
};
export const Failed: Story = {
  args: { state: "failed" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // The text is announced; the controls are not inside a live region.
    const alert = canvas.getByRole("alert");
    await expect(alert).toHaveTextContent("Save failed");
    await expect(alert.querySelector("button")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: /Retry/ }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
    await userEvent.click(
      canvas.getByRole("button", { name: "Download a copy" }),
    );
    await expect(args.onDownload).toHaveBeenCalledOnce();
  },
};
export const FailedCompact: Story = {
  args: { state: "failed", compact: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /Retry/ })).toBeVisible();
    // CSS takes Download a copy out of the compact form; the class is the contract.
    await expect(
      canvas.getByRole("group", { name: "Save status" }),
    ).toHaveClass("sys-save--compact");
  },
};
