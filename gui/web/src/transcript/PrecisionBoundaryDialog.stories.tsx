import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { useDaw } from "../state/useDaw";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { MIRA } from "../test/episodeFixture";
import { openDialogByLauncher } from "../test/storyDialog";
import { withEpisode } from "../test/withEpisode";
import type { EditBoundaryView } from "../types/project";
import { PrecisionBoundaryDialog } from "./PrecisionBoundaryDialog";

const CLIP_ID = `clip-${MIRA}`;
const target = { kind: "trim", clip_id: CLIP_ID, edge: "out" } as const;
const geometry = [
  {
    id: CLIP_ID,
    source_start: 0,
    source_end: 40.6,
    timeline_start: 0,
    source_id: null,
  },
];
const boundary: EditBoundaryView = {
  id: "eb:clip-mira-voice",
  track_id: MIRA,
  left_clip_id: CLIP_ID,
  right_clip_id: null,
  timeline_join_sec: 40.6,
  cutaway_source_start: 40.6,
  cutaway_source_end: 41.4,
  has_cutaway: true,
  cutaway_word_ids: [
    {
      track_id: MIRA,
      source_id: null,
      word_index: 80,
      text: "so",
      start: 40.7,
      end: 40.9,
    },
    {
      track_id: MIRA,
      source_id: null,
      word_index: 81,
      text: "anyway",
      start: 41,
      end: 41.4,
    },
  ],
};
const context = {
  target,
  token: "boundary-token-1",
  track_id: MIRA,
  geometry,
  current: { source_sec: 40.6, timeline_sec: 40.6 },
  limits: { min: 38, max: 44, fine_step_sec: 0.001, regular_step_sec: 0.01 },
};
const audition = {
  token: "boundary-token-2",
  actual_edit: { ...target, source_sec: 40.85, mode: "ripple" },
  current: {
    url: "/api/boundary/audio/current",
    window_start_sec: 39.8,
    window_end_sec: 41.4,
    duration_sec: 1.6,
    seam_offset_sec: 0.8,
  },
  proposed: {
    url: "/api/boundary/audio/proposed",
    window_start_sec: 40.05,
    window_end_sec: 41.65,
    duration_sec: 1.6,
    seam_offset_sec: 0.8,
  },
};
const loaded = {
  episode: { responses: { "/api/boundary/context": context } },
};

function BoundaryDialogPreview({
  onApply,
}: Pick<ComponentProps<typeof PrecisionBoundaryDialog>, "onApply">) {
  const projectPath = useDaw((s) => s.projectPath);
  return (
    <DialogLauncher label="Open boundary dialog" initiallyOpen>
      {(open, close) => (
        <PrecisionBoundaryDialog
          open={open}
          onClose={close}
          projectPath={projectPath}
          target={target}
          expectedGeometry={geometry}
          boundary={boundary}
          onApply={onApply}
        />
      )}
    </DialogLauncher>
  );
}

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open boundary dialog",
    dialogName: "Adjust boundary",
  });

async function applyOffset(canvasElement: HTMLElement, offset: string) {
  const dialog = within(await openDialog(canvasElement));
  const field = await dialog.findByLabelText("Change boundary by (seconds)");
  await userEvent.clear(field);
  await userEvent.type(field, offset);
  await userEvent.click(dialog.getByRole("button", { name: "Apply" }));
  return dialog;
}

const meta: Meta<typeof BoundaryDialogPreview> = {
  title: "Templates/Editor · Precision boundary dialog",
  component: BoundaryDialogPreview,
  decorators: [withEpisode],
  args: { onApply: fn(async () => ({ queued: false })) },
  parameters: { ...isolatedStoryParameters, episode: {} },
};
export default meta;
type Story = StoryObj<typeof BoundaryDialogPreview>;

export const Loading: Story = {
  parameters: { episode: { hang: ["/api/boundary/context"] } },
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    await expect(
      await dialog.findByText("Preparing boundary controls…"),
    ).toBeVisible();
  },
};

export const Editing: Story = {
  parameters: loaded,
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    await expect(
      await dialog.findByLabelText("Change boundary by (seconds)"),
    ).toHaveValue(0);
  },
};

export const RestoringWords: Story = {
  parameters: loaded,
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    const field = await dialog.findByLabelText("Change boundary by (seconds)");
    await userEvent.clear(field);
    await userEvent.type(field, "0.8");
    await expect(
      await dialog.findByText("All cutaway word spans are fully restored."),
    ).toBeVisible();
  },
};

export const Auditioning: Story = {
  parameters: {
    episode: {
      responses: {
        "/api/boundary/context": context,
        "/api/boundary/audition": audition,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    const field = await dialog.findByLabelText("Change boundary by (seconds)");
    await userEvent.clear(field);
    await userEvent.type(field, "0.25");
    await userEvent.click(
      await dialog.findByRole("button", { name: "Listen proposed" }),
    );
    await expect(await dialog.findByText(/This track audition/)).toBeVisible();
  },
};

export const Saving: Story = {
  parameters: loaded,
  args: { onApply: () => new Promise(() => {}) },
  play: async ({ canvasElement }) => {
    const dialog = await applyOffset(canvasElement, "0.05");
    await expect(
      await dialog.findByRole("button", { name: "Saving boundary…" }),
    ).toBeDisabled();
  },
};

export const Queued: Story = {
  parameters: loaded,
  args: { onApply: async () => ({ queued: true }) },
  play: async ({ canvasElement }) => {
    const dialog = await applyOffset(canvasElement, "0.05");
    await expect(
      await dialog.findByText(/Boundary change queued for sync/),
    ).toBeVisible();
  },
};

export const SaveError: Story = {
  parameters: loaded,
  args: {
    onApply: async () => {
      throw new Error("The boundary changed. Reload and try again.");
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await applyOffset(canvasElement, "0.05");
    await expect(
      await dialog.findByText("The boundary changed. Reload and try again."),
    ).toBeVisible();
  },
};

export const LoadError: Story = {
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    await expect(await dialog.findByRole("alert")).toBeVisible();
  },
};

export const GuestHidden: Story = {
  parameters: { ...loaded, episode: { ...loaded.episode, role: "viewer" } },
  play: async ({ canvasElement }) => {
    const dialog = within(await openDialog(canvasElement));
    await expect(
      await dialog.findByText(
        "Precision boundary audition is available in the host editor.",
      ),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  parameters: { ...loaded, ...recordMobileViewport.parameters },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(await openDialog(canvasElement)).toBeVisible();
  },
};
