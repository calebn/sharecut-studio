import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { DialogLauncher } from "../test/DialogLauncher";
import { registryModels, withModels } from "../test/modelsStory";
import { openDialogByLauncher } from "../test/storyDialog";
import { ModelsDialog } from "./ModelsDialog";

const openDialog = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open models",
    dialogName: "Models",
  });

const meta: Meta<typeof ModelsDialog> = {
  title: "Templates/Models dialog",
  component: ModelsDialog,
  tags: ["autodocs"],
  decorators: [withModels],
  parameters: { ...isolatedStoryParameters, layout: "padded" },
  render: (_args, context) => (
    <DialogLauncher
      label="Open models"
      initiallyOpen={context.viewMode === "story"}
    >
      {(open, close) => <ModelsDialog open={open} onClose={close} />}
    </DialogLauncher>
  ),
};

export default meta;
type Story = StoryObj<typeof ModelsDialog>;

export const FreshMachine: Story = {
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getAllByRole("button", { name: /Download/ }),
    ).toHaveLength(4);
  },
};

export const Mixed: Story = {
  parameters: {
    models: {
      models: registryModels({
        whisper: { kind: "installed" },
        rnnoise: {
          kind: "downloading",
          bytes: 120_000,
          total: 297_646,
        },
        "word-aligner": { kind: "update_needed" },
        "speaker-ecapa": {
          kind: "failed",
          failure: {
            kind: "network",
            plain:
              "Couldn't reach the download server. Check your internet connection and try again.",
          },
        },
      }),
      busy: true,
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByRole("button", { name: /Cancel/ }),
    ).toBeVisible();
    await expect(
      within(dialog).getByRole("button", { name: /Retry/ }),
    ).toBeDisabled();
  },
};

export const AllInstalled: Story = {
  parameters: {
    models: {
      models: registryModels({
        whisper: { kind: "installed" },
        rnnoise: { kind: "installed" },
        "word-aligner": { kind: "installed" },
        "speaker-ecapa": { kind: "installed" },
      }),
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).queryByRole("button", { name: /Download/ }),
    ).toBeNull();
  },
};

export const AudioToolsMissing: Story = {
  parameters: {
    models: { tools: { ffmpeg: "missing", hint: null } },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/Audio tools are unavailable/),
    ).toBeVisible();
  },
};

export const Checking: Story = {
  parameters: { models: { models: null } },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText("Checking installed models…"),
    ).toBeVisible();
  },
};

export const LoadFailed: Story = {
  parameters: {
    models: {
      models: null,
      loadError: "Could not read the model status from the local server.",
    },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openDialog(canvasElement);
    await expect(
      within(dialog).getByText(/Could not read the model status/),
    ).toBeVisible();
  },
};
