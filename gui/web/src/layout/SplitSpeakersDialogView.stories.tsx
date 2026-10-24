import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ModelGate } from "../models";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { openDialogByLauncher } from "../test/storyDialog";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { HistoryEntryId } from "../types/project";
import type { SplitSpeakersResult } from "../utils/speakerSplit";
import { SplitSpeakersDialogView } from "./SplitSpeakersDialogView";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open split speakers dialog",
    dialogName: "Split speakers",
  });

const runningJob = {
  id: "s1",
  project_path: "/episodes/ep12/episode.project.json",
  from_step: null,
  only_step: null,
  kind: "split_speakers",
  status: "running",
  current: 230,
  total: 669,
  message: "Embedding 667 windows",
  error: null,
  elapsed_sec: 74,
  last_progress_at: 1_000,
  steps: [],
} satisfies PipelineJobSnapshot;

const needsModelGate: ModelGate = {
  run: () => Promise.reject(new Error("Not used in a preview")),
  prompt: {
    need: { id: "speaker-ecapa" },
    label: "Speaker model",
    purpose: "speaker recognition and split",
    size: "~25 MB",
    phase: "ask",
    blockedReason: undefined,
    view: {
      id: "speaker-ecapa",
      label: "Speaker model",
      purpose: "speaker recognition and split",
      tier: "offered",
      size: "~25 MB",
      sizeBytes: null,
      variant: null,
      state: { kind: "missing" },
    },
  },
  declined: null,
  accept: fn(),
  decline: fn(),
  cancelDownload: fn(),
  openModels: fn(),
  reset: fn(),
};

const result: SplitSpeakersResult = {
  split_id: "split_1",
  lanes: [
    { track_id: "room", name: "Caleb", muted_sec: 102 },
    { track_id: "room_audra", name: "Audra", muted_sec: 124 },
    { track_id: "room_lana", name: "Lana", muted_sec: 143 },
  ],
  crosstalk_sec: 3,
  low_confidence_sec: 13,
  review_spans: [
    {
      start_s: 32,
      end_s: 34.5,
      speakers: ["room_audra", "room_lana"],
      unsure: false,
      overlapping: true,
      timeline_spans: [{ start_s: 32, end_s: 34.5 }],
    },
  ],
  history_head_id: "h2" as HistoryEntryId,
};

function SplitSpeakersDialogPreview({
  initiallyOpen,
  ...args
}: ComponentProps<typeof SplitSpeakersDialogView> & {
  initiallyOpen: boolean;
}) {
  return (
    <DialogLauncher
      label="Open split speakers dialog"
      initiallyOpen={initiallyOpen}
    >
      {(open, close) => (
        <SplitSpeakersDialogView
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

const meta: Meta<typeof SplitSpeakersDialogView> = {
  title: "Templates/SplitSpeakersDialog",
  component: SplitSpeakersDialogView,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  args: {
    open: false,
    onClose: fn(),
    onDownloadSpeakerModel: fn(),
    trackLabel: "Interview",
    stage: {
      kind: "configure",
      count: "3",
      names: [],
      samples: [],
      sampleReason: "Select a range on the timeline first",
      blocker: null,
      countError: null,
      speakerReadiness: "available",
    },
    onCountChange: fn(),
    onNameChange: fn(),
    onMarkSample: fn(),
    onClearSample: fn(),
    onListenSample: fn(),
    onSplit: fn(),
    onCancelSplit: fn(),
    onUndo: fn(),
    onGoTo: fn(),
    onRestart: fn(),
    nowSec: 1_005,
  },
  argTypes: { open: { control: false } },
  render: (args, context) => (
    <SplitSpeakersDialogPreview
      {...args}
      initiallyOpen={context.viewMode === "story"}
    />
  ),
};

export default meta;
type Story = StoryObj<typeof SplitSpeakersDialogView>;

export const Settings: Story = {
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Speaker 1" }),
      "C",
    );
    await expect(args.onNameChange).toHaveBeenCalledWith(0, "C");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Split speakers" }),
    );
    await expect(args.onSplit).toHaveBeenCalledOnce();
  },
};

export const CountOutOfRange: Story = {
  args: {
    stage: {
      kind: "configure",
      count: "9",
      names: [],
      samples: [],
      sampleReason: "Select a range on the timeline first",
      blocker: "Enter 2 to 8 speakers.",
      countError: "Enter 2 to 8 speakers.",
      speakerReadiness: "available",
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: "Split speakers" }),
    ).toBeDisabled();
    await expect(
      within(dialog).getByText("Enter 2 to 8 speakers."),
    ).toBeVisible();
  },
};

export const Splitting: Story = {
  args: {
    stage: {
      kind: "running",
      job: runningJob,
      cancelReason: null,
      cancelling: false,
      cancelError: null,
    },
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(within(dialog).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "34",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel split" }),
    );
    await expect(args.onCancelSplit).toHaveBeenCalledOnce();
  },
};

export const Split: Story = {
  args: {
    stage: {
      kind: "done",
      result,
      reviewSpans: [
        {
          start_s: 32,
          end_s: 34.5,
          clock: "Timeline",
          labels: ["Overlapping speech"],
          trackNames: ["Audra", "Lana"],
          timelineSec: 32,
        },
      ],
      durationSec: 184.7,
      canUndo: true,
      undoing: false,
      undoError: null,
    },
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Split Interview into 3 tracks."),
    ).toBeVisible();
    await expect(within(dialog).getByText("Plays 1:23 of 3:05")).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Undo split" }),
    );
    await expect(args.onUndo).toHaveBeenCalledOnce();
  },
};

export const SplitNoLongerLatest: Story = {
  args: {
    stage: {
      kind: "done",
      result,
      reviewSpans: [
        {
          start_s: 32,
          end_s: 34.5,
          clock: "Timeline",
          labels: ["Overlapping speech"],
          trackNames: ["Audra", "Lana"],
          timelineSec: 32,
        },
      ],
      durationSec: 184.7,
      canUndo: false,
      undoing: false,
      undoError: null,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).queryByRole("button", { name: "Undo split" }),
    ).toBeNull();
    await expect(
      within(dialog).getByText(/Something else changed since the split/),
    ).toBeVisible();
  },
};

export const NeedsModel: Story = {
  args: { stage: { kind: "needsModel", gate: needsModelGate } },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/stored on this computer/),
    ).toBeVisible();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Download" }),
    );
    await expect(needsModelGate.accept).toHaveBeenCalledOnce();
  },
};

export const Failed: Story = {
  args: {
    stage: {
      kind: "failed",
      reason: "speaker split needs a speaker embedding",
    },
  },
  play: async ({ args, canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Try again" }),
    );
    await expect(args.onRestart).toHaveBeenCalledOnce();
  },
};

export const Cancelled: Story = {
  args: { stage: { kind: "cancelled" } },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Split cancelled. Interview is unchanged."),
    ).toBeVisible();
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
