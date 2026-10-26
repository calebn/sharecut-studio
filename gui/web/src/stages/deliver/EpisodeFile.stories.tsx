import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
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
