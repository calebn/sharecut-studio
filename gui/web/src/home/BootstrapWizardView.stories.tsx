import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ANOTHER_DOWNLOAD_REASON } from "../models";
import { registryModels, withModels } from "../test/modelsStory";
import { BootstrapWizardView } from "./BootstrapWizardView";

const meta: Meta<typeof BootstrapWizardView> = {
  title: "Templates/Home · Setup wizard",
  component: BootstrapWizardView,
  decorators: [withModels],
  parameters: { layout: "centered" },
  args: {
    models: registryModels(),
    loadError: null,
    toolsOk: true,
    busy: false,
    summary: "Download 1.6 GB",
    summaryId: "wizard-summary",
    stuckReason: undefined,
    stuckId: "wizard-stuck",
    continueReason: undefined,
    actionFor: (model) =>
      model.state.kind === "installed"
        ? { kind: "none" }
        : {
            kind: "select",
            checked: model.tier !== "offered",
            locked: model.tier === "required",
            onToggle: fn(),
          },
    onContinue: fn(),
    onSkip: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof BootstrapWizardView>;

export const Choosing: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Set up ShareCut Studio" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(args.onContinue).toHaveBeenCalledOnce();
  },
};

export const Checking: Story = {
  args: { models: null },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Checking installed tools…"),
    ).toBeVisible();
  },
};

export const LoadFailed: Story = {
  args: { models: null, loadError: "Could not reach the local server." },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Skip for now" }));
    await expect(args.onSkip).toHaveBeenCalledOnce();
  },
};

export const AudioToolsMissing: Story = {
  args: { toolsOk: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("link", {
        name: "setup guide for the audio tools",
      }),
    ).toBeVisible();
  },
};

export const NothingPicked: Story = {
  args: {
    summary: "Nothing to download",
    stuckReason:
      "Nothing is picked to download, and setup cannot finish without the audio tools.",
    continueReason:
      "Nothing is picked to download, and setup cannot finish without the audio tools.",
    toolsOk: false,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  },
};

export const Downloading: Story = {
  args: {
    busy: true,
    summary: "Download in progress",
    models: registryModels({
      whisper: {
        kind: "downloading",
        bytes: 640_000_000,
        total: 1_600_000_000,
      },
      rnnoise: { kind: "queued" },
    }),
    actionFor: (model) =>
      model.state.kind === "missing"
        ? {
            kind: "select",
            checked: false,
            locked: true,
            lockedNoteId: "wizard-summary",
            onToggle: fn(),
          }
        : { kind: "none" },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Downloading…" }),
    ).toBeVisible();
  },
};

export const RowFailed: Story = {
  args: {
    models: registryModels({
      whisper: {
        kind: "failed",
        failure: {
          kind: "network",
          plain:
            "Couldn't reach the download server. Check your internet connection and try again.",
        },
      },
    }),
    actionFor: (model) =>
      model.state.kind === "failed"
        ? {
            kind: "download",
            onDownload: fn(),
            blockedReason: undefined,
          }
        : { kind: "none" },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: /Retry/ }),
    ).toBeVisible();
  },
};

export const AnotherDownloadRunning: Story = {
  args: {
    models: registryModels({
      whisper: {
        kind: "failed",
        failure: { kind: null, plain: "The download stopped." },
      },
    }),
    busy: true,
    actionFor: () => ({
      kind: "download",
      onDownload: fn(),
      blockedReason: ANOTHER_DOWNLOAD_REASON,
    }),
  },
};
