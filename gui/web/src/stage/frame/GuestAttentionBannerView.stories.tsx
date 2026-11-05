import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { offlineConflict } from "../../test/fixtures";
import { frameStoryDecorator } from "./frameStoryDecorator";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

/** The banner draws into the document body, outside the story canvas. */
const region = (canvasElement: HTMLElement, name: string) =>
  within(
    within(canvasElement.ownerDocument.body).getByRole("region", { name }),
  );

const meta: Meta<typeof GuestAttentionBannerView> = {
  title: "Templates/GuestAttentionBanner",
  component: GuestAttentionBannerView,
  parameters: { layout: "fullscreen" },
  decorators: [frameStoryDecorator],
  args: {
    conflicts: [],
    onDismissAll: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof GuestAttentionBannerView>;

export const Conflicts: Story = {
  args: {
    conflicts: [
      offlineConflict({
        command: { command_id: "conflict-1", type: "SetEnvelope" },
        reason: "Envelope changed since this edit was queued",
      }),
      offlineConflict({
        command: { command_id: "conflict-2", type: "TrimClip" },
        reason: "Clip was already trimmed",
      }),
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(
      within(canvasElement.ownerDocument.body).getByRole("region", {
        name: "Needs attention. 2 conflicts",
      }),
    );
    await userEvent.click(canvas.getByLabelText("Needs attention 2 Details"));
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss all" }));
    await expect(args.onDismissAll).toHaveBeenCalledTimes(1);
  },
};

export const PhoneManyConflicts: Story = {
  parameters: { ...recordMobileViewport.parameters, framePhone: true },
  globals: recordMobileViewport.globals,
  args: {
    conflicts: Array.from({ length: 7 }, (_, i) =>
      offlineConflict({ command: { command_id: `conflict-phone-${i}` } }),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(
      within(canvasElement.ownerDocument.body).getByRole("region", {
        name: "Needs attention. 7 conflicts",
      }),
    );
    await userEvent.click(canvas.getByLabelText("Needs attention 7 Details"));
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await expect(canvas.getByText("+2 more")).toHaveClass(
      "guest-attention-more",
    );
  },
};

export const Unreadable: Story = {
  args: { unreadable: true, onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    const banner = region(
      canvasElement,
      "Needs attention. Saved edits could not be read",
    );
    await userEvent.click(banner.getByLabelText("Needs attention ! Details"));
    await expect(
      banner.getByText(/Could not read saved edits on this device/),
    ).toBeVisible();
    await userEvent.click(banner.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const DismissFailed: Story = {
  args: {
    dismissFailed: true,
    onRetry: fn(),
    conflicts: [offlineConflict({ command: { command_id: "conflict-4" } })],
  },
  play: async ({ canvasElement }) => {
    const banner = region(
      canvasElement,
      "Needs attention. 1 conflict. Dismissal failed",
    );
    await userEvent.click(banner.getByLabelText("Needs attention 1 Details"));
    await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(
      banner.getByRole("button", { name: "Dismiss all" }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};

export const CheckingSavedEdits: Story = {
  args: {
    checking: true,
    conflicts: [offlineConflict({ command: { command_id: "conflict-5" } })],
  },
  play: async ({ canvasElement, args }) => {
    const banner = region(canvasElement, "Needs attention. 1 conflict");
    await userEvent.click(banner.getByLabelText("Needs attention 1 Details"));
    const dismiss = banner.getByRole("button", { name: "Dismiss all" });
    await expect(dismiss).toHaveAttribute("aria-disabled", "true");
    await expect(dismiss).toHaveAccessibleDescription(
      "Checking saved edits. Dismissal is unavailable.",
    );
    await expect(args.onDismissAll).not.toHaveBeenCalled();
  },
};

export const GuestProjectFileBroken: Story = {
  args: {
    conflicts: [
      offlineConflict({
        reason: "The project file is damaged",
        command: { command_id: "blocked-1" },
        blocksSave: true,
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const banner = region(canvasElement, "Needs attention. 1 conflict");
    await userEvent.click(banner.getByLabelText("Needs attention 1 Details"));
    await expect(
      banner.getByText("Ask the project owner to check the project."),
    ).toBeVisible();
  },
};
