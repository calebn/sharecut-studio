import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { ExportDialogView } from "./ExportDialogView";
import { exportSettingsFromConfig } from "./exportSettings";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open export dialog",
    dialogName: "Export deliverables",
  });

const settings = exportSettingsFromConfig({
  export: {
    wav: true,
    formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
  },
  master: { integrated_lufs: -16, true_peak_db: -1.5 },
});

const runningJob = {
  id: "x1",
  project_path: "/episodes/ep12/episode.project.json",
  from_step: null,
  only_step: null,
  kind: "export",
  status: "running",
  current: 1,
  total: 2,
  message: "Writing deliverables…",
  error: null,
  elapsed_sec: 74,
  last_progress_at: 1_000,
  steps: [],
} satisfies PipelineJobSnapshot;

function ExportDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof ExportDialogView> & { initiallyOpen: boolean }) {
  return (
    <DialogLauncher label="Open export dialog" initiallyOpen={initiallyOpen}>
      {(open, close) => (
        <ExportDialogView
          {...args}
          open={open}
          onClose={() => {
            close();
            args.onClose();
          }}
        />
      )}
    </DialogLauncher>
  );
}

const meta: Meta<typeof ExportDialogView> = {
  title: "Templates/ExportDialog",
  component: ExportDialogView,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    stage: {
      kind: "configure",
      settings,
      settingsError: null,
      selected: ["mp3"],
      blocker: null,
    },
    onToggleFormat: fn(),
    onExport: fn(),
    onCancelExport: fn(),
    onRestart: fn(),
    nowSec: 1_005,
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <ExportDialogPreview
      {...args}
      initiallyOpen={context.viewMode === "story"}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof ExportDialogView>;

export const Settings: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(within(dialog).getByLabelText("FLAC · lossless"));
    await expect(args.onToggleFormat).toHaveBeenCalledWith("flac", true);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Export" }),
    );
    await expect(args.onExport).toHaveBeenCalledOnce();
  },
};

export const Exporting: Story = {
  args: {
    stage: {
      kind: "running",
      job: runningJob,
      canCancel: true,
      cancelling: false,
      cancelError: null,
    },
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(within(dialog).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel export" }),
    );
    await expect(args.onCancelExport).toHaveBeenCalledOnce();
  },
};

export const Exported: Story = {
  args: {
    stage: {
      kind: "done",
      paths: [
        "/episodes/ep12/export/Episode 12.wav",
        "/episodes/ep12/export/Episode 12.mp3",
      ],
      measured: "Measured −16.1 LUFS, true peak −1.6 dBTP.",
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Exported 2 files to export/"),
    ).toBeVisible();
  },
};

export const Failed: Story = {
  args: { stage: { kind: "failed", reason: "ffmpeg exited with status 1" } },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Try again" }),
    );
    await expect(args.onRestart).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(dialog).toBeVisible();
  },
};
