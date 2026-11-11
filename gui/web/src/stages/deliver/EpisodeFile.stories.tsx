import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { registryModels, withModels } from "../../test/modelsStory";
import {
  DONE,
  exportedFilesOf,
  NEEDS_MODEL,
  NEVER,
  REQUEST,
  SETTINGS,
  TOTAL,
} from "./deliverFixture";
import type { EpisodeSettings, LoudnessId } from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";

function Controlled(props: React.ComponentProps<typeof EpisodeFile>) {
  const [settings, setSettings] = useState<EpisodeSettings>(props.settings);
  const [choice, setChoice] = useState<LoudnessId | null>(null);
  const options = props.options?.loudness
    ? { ...props.options, loudness: { choice, onChoice: setChoice } }
    : props.options;
  return (
    <EpisodeFile
      {...props}
      options={options}
      settings={settings}
      onSettings={setSettings}
    />
  );
}

const meta: Meta<typeof EpisodeFile> = {
  title: "Stages/Deliver/EpisodeFile",
  component: EpisodeFile,
  tags: ["autodocs"],
  render: (args) => <Controlled {...args} />,
  args: {
    settings: SETTINGS,
    hasTranscriptSection: false,
    total: TOTAL,
    saveTo: "Field Notes/export",
    exportState: NEVER,
    onSettings: fn(),
    onChangeFolder: fn(),
    onExport: fn(),
    onCancel: fn(),
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
          "Format chips with a size estimate, loudness (set only here), Whole episode or Part with In and Out, the save folder, and the one filled button before an export. Available captions and transcript are included with every audio export. The note points to more formats only when the host includes a Transcript section, and stays unchanged while its preview loads.\n\n**Motion.** Animations come later: the progress bar uses `--motion-panel`.",
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
    const out = view.getByRole("spinbutton", { name: "Out" });
    await userEvent.click(out);
    await userEvent.keyboard("0:30{Enter}");
    const read = (name: string) =>
      view.getByRole("spinbutton", { name }).getAttribute("aria-valuetext");
    await expect(read("Out")).toBe("30.00 s");
    await userEvent.click(view.getByRole("button", { name: "Part…" }));
    await expect(read("Out")).toBe("30.00 s");
    await userEvent.click(view.getByRole("spinbutton", { name: "In" }));
    await userEvent.keyboard("9:00{Enter}");
    await expect(read("Out")).not.toBe("30.00 s");
  },
};

export const Exported: Story = {
  args: {
    exportState: DONE,
    files: { ...exportedFilesOf(REQUEST, "reveal"), onReveal: fn() },
  },
};

export const ExportedInBrowser: Story = {
  args: {
    exportState: DONE,
    files: { ...exportedFilesOf(REQUEST, "download"), onStarted: fn() },
  },
};

export const ExportingWithFiles: Story = {
  args: {
    exportState: {
      phase: "running",
      progress: 0.4,
      detail: "Mastering · 40%",
    },
    files: exportedFilesOf(REQUEST, "download"),
  },
};

export const NeedsModel: Story = {
  args: { exportState: NEEDS_MODEL },
  decorators: [withModels],
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Needs the transcription model"),
    ).toBeInTheDocument();
    await expect(view.getByText("1.6 GB")).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Get the transcription model" }),
    ).toBeEnabled();
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
  },
};

export const ModelDownloading: Story = {
  args: { exportState: NEEDS_MODEL },
  decorators: [withModels],
  parameters: {
    models: {
      models: registryModels({
        whisper: {
          kind: "downloading",
          bytes: 420_000_000,
          total: 1_600_000_000,
        },
      }),
      busy: true,
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("420 MB of 1.6 GB")).toBeInTheDocument();
    await userEvent.click(
      view.getByRole("button", {
        name: "Cancel the transcription model download",
      }),
    );
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
  loudnessNote: "Project target preview is −16.0 LUFS, peaks under −1.5 dBTP.",
  loudness: { choice: null, onChoice: fn() },
  range: false,
} as const;

export const WithProjectFormats: Story = {
  args: { options: HOST_OPTIONS },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("button", { name: "WAV" })).toBeDisabled();
    await expect(view.getByRole("button", { name: /^M4A/ })).toBeVisible();
    const loudness = within(view.getByRole("group", { name: "Loudness" }));
    const projectDefault = loudness.getByRole("button", {
      name: "Project default",
    });
    await expect(projectDefault).toHaveAttribute("aria-pressed", "true");
    const broadcast = loudness.getByRole("button", { name: /^Broadcast/ });
    await userEvent.click(broadcast);
    await expect(broadcast).toHaveAttribute("aria-pressed", "true");
    await expect(
      view.getByText("This export includes audio only."),
    ).toBeVisible();
    await userEvent.click(projectDefault);
    await expect(projectDefault).toHaveAttribute("aria-pressed", "true");
    await expect(view.queryByRole("group", { name: "Range" })).toBeNull();
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
      when: "at 2:14 PM",
    },
    options: { onExportAgain: fn() },
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

export const UnavailableFormat: Story = {
  args: {
    settings: { ...SETTINGS, formats: ["opus", "mp3"] },
    options: HOST_OPTIONS,
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const missing = view.getByRole("button", { name: "OPUS · unavailable" });
    await expect(missing).toHaveAttribute("aria-pressed", "true");
    await expect(missing).toBeEnabled();
    await expect(missing).toHaveTextContent(/^OPUS · unavailable$/);
    await expect(view.getByRole("button", { name: "Export" })).toBeDisabled();
    await expect(
      view.getByText("Remove unavailable formats before exporting."),
    ).toBeVisible();
    await userEvent.click(missing);
    await expect(
      view.queryByRole("button", { name: "OPUS · unavailable" }),
    ).toBeNull();
    await expect(view.getByRole("button", { name: "Export" })).toBeEnabled();
    await expect(view.getByRole("button", { name: /^MP3/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};
