import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ModelGate } from "../../models";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { registryModels } from "../../test/modelsStory";
import { DONE, NEEDS_MODEL, NEVER, SETTINGS, TOTAL } from "./deliverFixture";
import type { EpisodeSettings } from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";

function Controlled(props: React.ComponentProps<typeof EpisodeFile>) {
  const [settings, setSettings] = useState<EpisodeSettings>(props.settings);
  return (
    <EpisodeFile {...props} settings={settings} onSettings={setSettings} />
  );
}

const meta: Meta<typeof EpisodeFile> = {
  title: "Stages/Deliver/EpisodeFile",
  component: EpisodeFile,
  tags: ["autodocs"],
  render: (args) => <Controlled {...args} />,
  args: {
    settings: SETTINGS,
    total: TOTAL,
    saveTo: "Field Notes/export",
    exportState: NEVER,
    env: "app",
    onSettings: fn(),
    onChangeFolder: fn(),
    onExport: fn(),
    onCancel: fn(),
    onReveal: fn(),
    onDownload: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}>
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
          "Format chips with a size estimate, loudness (set only here), Whole episode or Part with In and Out, the save folder, and the one filled button. Captions and the transcript are written with every export, so there is no switch for them.\n\n**Motion.** Animations come later: the progress bar and the swap from Export to Reveal use `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof EpisodeFile>;

export const Settings: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const mp3 = view.getByRole("button", { name: /^MP3/ });
    await expect(mp3).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(mp3);
    await userEvent.click(view.getByRole("button", { name: /^WAV/ }));
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
    await userEvent.click(view.getByRole("button", { name: /^FLAC/ }));
    await expect(view.getByRole("button", { name: /^Export/ })).toBeEnabled();
  },
};

export const PartOfEpisode: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Part…" }));
    const out = view.getByRole("textbox", { name: "Out" });
    await userEvent.clear(out);
    await userEvent.type(out, "0:30{Enter}");
    await expect(out).toHaveValue("0:30.0");
    await userEvent.click(view.getByRole("button", { name: "Part…" }));
    await expect(out).toHaveValue("0:30.0");
    const start = view.getByRole("textbox", { name: "In" });
    await userEvent.clear(start);
    await userEvent.type(start, "9:00{Enter}");
    await expect(out).not.toHaveValue("0:30.0");
  },
};

export const Exported: Story = { args: { exportState: DONE } };

export const ExportedInBrowser: Story = {
  args: { exportState: DONE, env: "browser" },
};

export const NeedsModel: Story = {
  args: { exportState: NEEDS_MODEL, onGetModel: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("1.6 GB")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Get" }));
    await expect(args.onGetModel).toHaveBeenCalledOnce();
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const Phone: Story = {
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

const HOST_OPTIONS = {
  formats: [
    { id: "mp3", label: "MP3 · 128 kbps", bytesPerSecond: 16_000 },
    { id: "m4a", label: "M4A (AAC) · 128 kbps", bytesPerSecond: 16_000 },
    { id: "flac", label: "FLAC · lossless", bytesPerSecond: 97_000 },
  ],
  wavAlwaysWritten: true,
  loudnessNote: "Mastered to −16.0 LUFS, peaks under −1.5 dBTP.",
  loudness: false,
  range: false,
} as const;

export const WithProjectFormats: Story = {
  args: { options: HOST_OPTIONS, env: "none" },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("button", { name: "WAV" })).toBeDisabled();
    await expect(view.getByRole("button", { name: /^M4A/ })).toBeVisible();
    await expect(view.queryByRole("group", { name: "Loudness" })).toBeNull();
    await expect(view.queryByRole("group", { name: "Range" })).toBeNull();
    await expect(view.queryByText(/Saves to/)).toBeNull();
  },
};

export const SettingsDidNotLoad: Story = {
  args: { options: { settingsError: "The server did not answer." } },
};

export const StartingNoTotal: Story = {
  args: {
    exportState: {
      phase: "running",
      progress: null,
      detail: "Starting export…",
      cancelReason: "The export is still starting. Cancel once it has started.",
    },
  },
};

export const CancelFailed: Story = {
  args: {
    exportState: {
      phase: "running",
      progress: 0.4,
      detail: "Mastering · 40%",
      cancelError: "The server did not answer.",
    },
  },
};

export const FailedWithRetry: Story = {
  args: {
    exportState: { phase: "failed", cause: "The disk is full." },
    options: { onExportAgain: fn() },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    );
    await expect(args.options?.onExportAgain).toHaveBeenCalledTimes(1);
  },
};

export const Cancelled: Story = {
  args: {
    exportState: {
      phase: "cancelled",
      detail: "Cancelled after 1 file was written to export/.",
      files: [{ name: "episode.mp3", format: "mp3" }],
    },
    options: { onExportAgain: fn() },
    env: "none",
  },
};

export const SettingsLoading: Story = {
  args: { options: { loading: true, formats: [], wavAlwaysWritten: true } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("status")).toHaveTextContent(
      "Loading export settings…",
    );
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
  },
};

function askGate(): ModelGate {
  const view = registryModels({ "speaker-ecapa": { kind: "missing" } })[3];
  return {
    run: () => Promise.reject(new Error("The story does not run actions.")),
    prompt: {
      need: { id: view.id },
      label: view.label,
      purpose: view.purpose,
      size: view.size,
      phase: "ask",
      view,
      blockedReason: undefined,
    },
    declined: null,
    accept: fn(),
    decline: fn(),
    cancelDownload: fn(),
    openModels: fn(),
    reset: fn(),
  };
}

export const ModelGatePrompt: Story = {
  args: {
    exportState: {
      phase: "needs-model",
      model: "Speaker model",
      size: "25 MB",
    },
    options: { gate: askGate() },
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.queryByText("Needs the Speaker model")).toBeNull();
    await userEvent.click(view.getByRole("button", { name: "Download" }));
    await expect(args.options?.gate?.accept).toHaveBeenCalledOnce();
  },
};

export const FailedAfterDecline: Story = {
  args: {
    exportState: {
      phase: "failed",
      cause: "Speaker model is not downloaded.",
    },
    options: {
      gate: {
        ...askGate(),
        prompt: null,
        declined: { id: "speaker-ecapa", label: "Speaker model" },
      },
      onExportAgain: fn(),
    },
  },
};
