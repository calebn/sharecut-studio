import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import { offlineConflict } from "../../test/fixtures";
import { episodeBeforeEach } from "../../test/withEpisode";
import { DocumentCommand } from "../../types/documentCommands.generated";
import { TRANSCRIPT_REFINE_REFUSAL } from "../../utils/apiError";
import { frameStoryDecorator } from "./frameStoryDecorator";
import { GuestAttentionBannerView } from "./GuestAttentionBannerView";

const DETAILS = "Needs attention details and recovery actions";

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
    pending: 0,
    conflicts: [],
    onDismissAll: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof GuestAttentionBannerView>;

export const PendingHostEdits: Story = {
  args: { pending: 2 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("region", {
        name: "Needs attention. 2 pending",
      }),
    ).toBeInTheDocument();
  },
};

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
    await userEvent.click(
      canvas.getByLabelText("Needs attention details and recovery actions"),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss all" }));
    await expect(args.onDismissAll).toHaveBeenCalledTimes(1);
  },
};

export const PendingAndConflict: Story = {
  args: {
    pending: 1,
    conflicts: [
      offlineConflict({
        command: { command_id: "conflict-3", type: "SetEnvelope" },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement.ownerDocument.body).getByRole("region", {
        name: "Needs attention. 1 pending, 1 conflict",
      }),
    ).toBeInTheDocument();
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
    await userEvent.click(
      canvas.getByLabelText("Needs attention details and recovery actions"),
    );
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);
    await expect(canvas.getByText("+2 more")).toHaveClass(
      "guest-attention-more",
    );
  },
};

export const RefineWaiver: Story = {
  beforeEach: episodeBeforeEach,
  parameters: {
    episode: { responses: { "POST /api/transcript/refine/waive": {} } },
  },
  args: {
    refineWaiverProject: "/episodes/mira/episode.project.json",
    conflicts: [
      offlineConflict({
        reason: TRANSCRIPT_REFINE_REFUSAL,
        command: {
          command_id: "approve-1",
          type: DocumentCommand.ApproveEdits,
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const banner = region(canvasElement, "Needs attention. 1 conflict");
    await userEvent.click(banner.getByLabelText(DETAILS));
    await expect(banner.getByText(/^Approve:/)).toBeVisible();
    await expect(
      banner.getByRole("region", { name: "Transcript refine recovery" }),
    ).toBeVisible();
    await expect(banner.getByLabelText("Waiver reason")).toBeVisible();
    await userEvent.click(
      banner.getByRole("button", { name: "Waive with reason" }),
    );
    await expect(
      await banner.findByText(
        "A reason is required to waive transcript refinement.",
      ),
    ).toBeVisible();
    await userEvent.type(
      banner.getByLabelText("Waiver reason"),
      "Host approved the raw transcript",
    );
    await userEvent.click(
      banner.getByRole("button", { name: "Waive with reason" }),
    );
    await expect(
      await banner.findByText(
        "Waiver recorded. Retry approval to apply pending edits.",
      ),
    ).toBeVisible();
  },
};

export const SendPendingNow: Story = {
  args: { pending: 2, onSendNow: fn() },
  play: async ({ canvasElement, args }) => {
    const banner = region(canvasElement, "Needs attention. 2 pending");
    await userEvent.click(banner.getByLabelText(DETAILS));
    await userEvent.click(banner.getByRole("button", { name: "Send now" }));
    await expect(args.onSendNow).toHaveBeenCalledTimes(1);
  },
};

export const Unreadable: Story = {
  args: { unreadable: true, onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    const banner = region(
      canvasElement,
      "Needs attention. Saved edits could not be read",
    );
    await userEvent.click(banner.getByLabelText(DETAILS));
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
    await userEvent.click(banner.getByLabelText(DETAILS));
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
    await userEvent.click(banner.getByLabelText(DETAILS));
    const dismiss = banner.getByRole("button", { name: "Dismiss all" });
    await expect(dismiss).toHaveAttribute("aria-disabled", "true");
    await expect(dismiss).toHaveAccessibleDescription(
      "Checking saved edits. Dismissal is unavailable.",
    );
    await expect(args.onDismissAll).not.toHaveBeenCalled();
  },
};

export const InspectHistory: Story = {
  args: {
    onInspectHistory: fn(),
    conflicts: [
      offlineConflict({
        kind: "unknown",
        recovery: "inspect-history",
        reason: "The host did not confirm this edit",
        command: { command_id: "unknown-1", type: "TrimClip" },
      }),
    ],
  },
  play: async ({ canvasElement, args }) => {
    const banner = region(canvasElement, "Needs attention. 1 conflict");
    await userEvent.click(banner.getByLabelText(DETAILS));
    await expect(
      banner.getByText("Inspect History before trying this action again."),
    ).toBeVisible();
    await userEvent.click(
      banner.getByRole("button", { name: "Inspect History" }),
    );
    await expect(args.onInspectHistory).toHaveBeenCalledTimes(1);
  },
};

export const GuestProjectFileBroken: Story = {
  args: {
    guest: true,
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
    await userEvent.click(banner.getByLabelText(DETAILS));
    await expect(
      banner.getByText("Ask the project owner to check the project."),
    ).toBeVisible();
  },
};
