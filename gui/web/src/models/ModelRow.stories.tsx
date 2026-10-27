import type { Meta, StoryObj } from "@storybook/react-vite";
import { ModelRow } from "./ModelRow";
import type { ModelState, ModelView } from "./types";

const meta: Meta<typeof ModelRow> = {
  title: "Molecules/ModelRow",
  component: ModelRow,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <ul className="stack tight model-list">
        <Story />
      </ul>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ModelRow>;

function model(state: ModelState, over: Partial<ModelView> = {}): ModelView {
  return {
    id: "whisper",
    label: "Whisper",
    purpose: "transcription",
    tier: "required",
    size: "~1.6 GB",
    sizeBytes: 1_600_000_000,
    variant: "large-v3-turbo",
    state,
    ...over,
  };
}

const download = { kind: "download", onDownload: () => undefined } as const;

export const Installed: Story = {
  args: { model: model({ kind: "installed" }), action: { kind: "none" } },
};

export const Missing: Story = {
  args: { model: model({ kind: "missing" }), action: download },
};

export const UpdateNeeded: Story = {
  args: { model: model({ kind: "update_needed" }), action: download },
};

export const Queued: Story = {
  args: { model: model({ kind: "queued" }), action: download },
};

export const Downloading: Story = {
  args: {
    model: model({
      kind: "downloading",
      bytes: 420_000_000,
      total: 1_600_000_000,
    }),
    action: { ...download, onCancel: () => undefined },
  },
};

export const DownloadingUnknownTotal: Story = {
  args: {
    model: model({ kind: "downloading", bytes: 48_000_000, total: null }),
    action: download,
  },
};

export const Failed: Story = {
  args: {
    model: model({
      kind: "failed",
      failure: {
        kind: "network",
        plain:
          "Couldn't reach the download server. Check your internet connection and try again.",
      },
    }),
    action: download,
  },
};

export const BlockedByAnotherDownload: Story = {
  args: {
    model: model(
      { kind: "missing" },
      { tier: "offered", label: "Word aligner" },
    ),
    action: { ...download, blockedReason: "Another download is running" },
  },
};
