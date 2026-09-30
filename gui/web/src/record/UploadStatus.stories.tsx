import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordStoryDecorator } from "./recordStoryDecorator";
import { UploadStatus } from "./UploadStatus";
import type { RecordUploadProgress } from "./upload/useRecordUpload";

function progress(
  overrides: Partial<RecordUploadProgress> = {},
): RecordUploadProgress {
  return {
    acked: 2,
    total: 5,
    fileAck: false,
    landed: false,
    landFailed: false,
    reclaimFailed: false,
    uploading: false,
    pending: false,
    recoverable: false,
    error: null,
    ...overrides,
  };
}
const meta: Meta<typeof UploadStatus> = {
  title: "Templates/UploadStatus",
  component: UploadStatus,
  tags: ["autodocs"],
  decorators: [recordStoryDecorator],
  args: {
    stopped: true,
    progress: progress(),
    onResume: fn(),
    actions: {
      busy: false,
      error: null,
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
};
export default meta;
type Story = StoryObj<typeof UploadStatus>;
export const Uploading: Story = {
  args: { progress: progress({ uploading: true, pending: true }) },
};
export const WaitingToLand: Story = {
  args: { progress: progress({ acked: 5, fileAck: true }) },
};
export const Landed: Story = {
  args: { progress: progress({ acked: 5, fileAck: true, landed: true }) },
};
export const LandFailed: Story = {
  args: { progress: progress({ acked: 5, fileAck: true, landFailed: true }) },
};
export const UploadFailed: Story = {
  args: {
    progress: progress({ error: "The upload connection was interrupted." }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Resume upload" }),
    );
    await expect(args.onResume).toHaveBeenCalledOnce();
  },
};
export const PartialKeeper: Story = {
  args: {
    progress: progress({
      recoverable: true,
      error: "A readable partial keeper was retained.",
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Recover partial take",
      }),
    );
    await expect(args.actions?.recover).toHaveBeenCalledOnce();
  },
};
export const RecoveryBusy: Story = {
  args: {
    progress: progress({
      recoverable: true,
      error: "A readable partial keeper was retained.",
    }),
    actions: {
      busy: true,
      error: null,
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Recovering partial take…",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};
export const RecoveryFailed: Story = {
  args: {
    progress: progress({
      recoverable: true,
      error: "A readable partial keeper was retained.",
    }),
    actions: {
      busy: false,
      error: "An incomplete PCM frame could not be recovered.",
      notice: null,
      download: fn(),
      recover: fn(),
    },
  },
};
export const ReclaimFailed: Story = {
  args: {
    progress: progress({
      acked: 5,
      fileAck: true,
      landed: true,
      reclaimFailed: true,
    }),
  },
};
export const FingerprintMismatch: Story = {
  args: {
    progress: progress({
      acked: 5,
      fileAck: true,
      landed: true,
      reclaimMismatch: true,
    }),
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Download local keeper",
      }),
    );
    await expect(args.actions?.download).toHaveBeenCalledOnce();
  },
};
