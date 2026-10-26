import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { registryModels, withModels } from "../test/modelsStory";
import {
  WhisperDownloadDialog,
  WhisperModelPicker,
} from "./WhisperModelPicker";

const catalog = [
  {
    id: "large-v3-turbo",
    label: "Recommended",
    size: "~1.6 GB",
    description: "Lowest practical error for podcasts.",
    cached: true,
  },
  {
    id: "small.en",
    label: "Balanced (English)",
    size: "~500 MB",
    description: "Good laptop default if disk is tight.",
    cached: false,
  },
];

const meta: Meta = {
  title: "Templates/Whisper model",
  decorators: [withModels],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj;

export const Picker: Story = {
  render: () => (
    <WhisperModelPicker
      fieldLabel="Whisper model"
      fieldDescription="Larger models transcribe more accurately and take longer."
      value="large-v3-turbo"
      defaultValue="large-v3-turbo"
      models={catalog}
      onSelectCached={fn()}
      onSelectMissing={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Recommended is downloaded (~1.6 GB)."),
    ).toBeVisible();
  },
};

export const PickerNeedsDownload: Story = {
  render: () => (
    <WhisperModelPicker
      fieldLabel="Whisper model"
      fieldDescription="Larger models transcribe more accurately and take longer."
      value="small.en"
      defaultValue="large-v3-turbo"
      models={catalog}
      onSelectCached={fn()}
      onSelectMissing={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Balanced (English) needs download (~500 MB).",
      ),
    ).toBeVisible();
  },
};

export const PickerChoosing: Story = {
  render: () => {
    const onSelectMissing = fn();
    return (
      <WhisperModelPicker
        fieldLabel="Whisper model"
        fieldDescription="Larger models transcribe more accurately and take longer."
        value="large-v3-turbo"
        defaultValue="large-v3-turbo"
        models={catalog}
        onSelectCached={fn()}
        onSelectMissing={onSelectMissing}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const select = within(canvasElement).getByRole("combobox");
    await userEvent.selectOptions(select, "small.en");
    await expect(select).toHaveValue("large-v3-turbo");
  },
};

const pending = { modelId: "small.en", previousId: "large-v3-turbo" };

function downloadDialog() {
  return (
    <WhisperDownloadDialog
      pending={pending}
      models={catalog}
      onDefer={fn()}
      onCancel={fn()}
      onDownloaded={fn()}
    />
  );
}

export const DownloadAsk: Story = {
  render: downloadDialog,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: "Download Whisper model?",
    });
    await expect(
      within(dialog).getByRole("button", { name: "Use without downloading" }),
    ).toBeEnabled();
  },
};

export const Downloading: Story = {
  render: downloadDialog,
  parameters: {
    models: {
      models: registryModels({
        whisper: {
          kind: "downloading",
          bytes: 410_000_000,
          total: 500_000_000,
        },
      }),
      busy: true,
    },
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", {
      name: "Download Whisper model?",
    });
    await expect(
      within(dialog).getByRole("button", { name: "Downloading…" }),
    ).toBeDisabled();
  },
};
