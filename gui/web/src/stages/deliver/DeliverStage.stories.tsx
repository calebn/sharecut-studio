import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { playInCanvas } from "../../storybook/storyPlay";
import { withModels } from "../../test/modelsStory";
import { isApplePlatform } from "../../utils/platform";
import { DeliverStage, type DeliverStageProps } from "./DeliverStage";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  exportedFilesOf,
  exportedState,
  FAILED,
  LINK,
  MEASURED_FACTS,
  NEEDS_MODEL,
  NEVER,
  OPEN_FACTS,
  REQUEST,
  RUNNING,
  SETTINGS,
  STALE,
  TOTAL,
} from "./deliverFixture";
import { type ListenFixture, listenOf } from "./listenFixture";

const MOD_E = isApplePlatform() ? "{Meta>}e{/Meta}" : "{Control>}e{/Control}";

/** The stage's props, and the plain fields the host's Listen link row is built from. */
type StoryArgs = DeliverStageProps & {
  link?: ListenFixture;
  onRefreshMix?: () => void;
};

function Live({ link, onRefreshMix, ...props }: StoryArgs) {
  const [exportState, setExportState] = useState(props.exportState);
  const [files, setFiles] = useState(props.files);
  const [copy, setCopy] = useState<"idle" | "copied">("idle");
  const [url, setUrl] = useState(link?.url ?? null);
  return (
    <DeliverStage
      {...props}
      exportState={exportState}
      files={files}
      listen={listenOf({
        ...link,
        url,
        copyState: copy,
        onRefreshMix,
        onCopy: () => {
          setUrl(LINK);
          setCopy("copied");
        },
      })}
      onExport={(request) => {
        props.onExport(request);
        setExportState(exportedState(request));
        setFiles(exportedFilesOf(request, props.files?.access ?? "reveal"));
      }}
    />
  );
}

const meta: Meta<StoryArgs> = {
  title: "Stages/Deliver/Deliver",
  component: DeliverStage,
  tags: ["autodocs"],
  render: (args) => <Live {...args} />,
  decorators: [
    (Story) => (
      <div style={{ blockSize: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    facts: CLEAR_FACTS,
    total: TOTAL,
    initialSettings: SETTINGS,
    initialChapters: CHAPTERS,
    initialClips: CLIPS,
    saveTo: "Field Notes/export",
    exportState: NEVER,
    files: { files: [], access: "reveal", onReveal: fn(), onStarted: fn() },
    clock: { time: "12:04", total: "52:00" },
    getPlayheadSec: () => 724,
    link: { url: null },
    toastMs: 600_000,
    onFix: fn(),
    onExport: fn(),
    onCancel: fn(),
    onChangeFolder: fn(),
    onRefreshMix: fn(),
    onPlayFrom: fn(),
    onPlayClip: fn(),
    onFindClips: fn(),
    onOpenClipInEdit: fn(),
    onRetry: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Deliver: Readiness first, then the episode file, the listen link, chapters and clips. Export is the only filled button until a file exists; then Reveal or Download takes over as the filled button and each file is a row with its own quiet Reveal (app) or Download (browser) action, and Copy link is the follow-up. Nothing in Readiness blocks Export. Mod+E (from anywhere in the app) exports. Presentational: the export job, the link and the data come in as props, and the buttons call back.\n\n**Motion.** Animations come later: the export progress uses `--motion-panel`, the copied label holds for 2 s.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<StoryArgs>;

export const Ready: Story = {
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Ready to export")).toBeInTheDocument();
    await expect(view.queryByRole("button", { name: /^Review \d/ })).toBeNull();
    canvasElement.querySelector<HTMLElement>(".dv-stage")?.focus();
    await userEvent.keyboard(MOD_E);
    await expect(args.onExport).not.toHaveBeenCalled();
    await userEvent.click(view.getByRole("button", { name: /^Export/ }));
    await expect(args.onExport).toHaveBeenCalledOnce();
    await expect(
      await view.findByRole("button", { name: /^Reveal field-notes\.mp3/ }),
    ).toBeInTheDocument();
    await expect(view.getByRole("button", { name: /^Export/ })).toBeEnabled();
  }),
};

export const ItemsOpen: Story = {
  args: { facts: OPEN_FACTS },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("2 things left. You can still export."),
    ).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Resolve" }));
    await expect(args.onFix).toHaveBeenCalledWith("review", "comments");
    await expect(view.getByRole("button", { name: /^Export/ })).toBeEnabled();
    await userEvent.click(
      view.getByRole("button", { name: "Review 3 open items" }),
    );
    await expect(args.onFix).toHaveBeenLastCalledWith("review", "comments");
  }),
};

export const Exporting: Story = {
  args: { exportState: RUNNING },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
    await userEvent.click(view.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  }),
};

export const Exported: Story = {
  args: {
    exportState: DONE,
    files: { ...exportedFilesOf(REQUEST, "reveal"), onReveal: fn() },
    facts: MEASURED_FACTS,
    link: { url: null },
  },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: /^Reveal field-notes\.mp3/ }),
    );
    await expect(args.files?.onReveal).toHaveBeenCalledOnce();
    await userEvent.click(
      view.getByRole("button", { name: "Copy listen link" }),
    );
    await expect(
      await view.findByRole("button", { name: "Copied listen link" }),
    ).toBeInTheDocument();
  }),
};

export const ExportedInBrowser: Story = {
  args: {
    exportState: DONE,
    files: exportedFilesOf(REQUEST, "download"),
    facts: MEASURED_FACTS,
  },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("link", { name: /^Download field-notes\.mp3/ }),
    ).toBeInTheDocument();
    await expect(view.queryByText("Download all")).toBeNull();
  }),
};

export const ExportedWithUnconfirmedSettings: Story = {
  args: {
    ...ExportedInBrowser.args,
    files: exportedFilesOf({ ...REQUEST, clips: [] }, "download"),
    exportState: {
      ...DONE,
      phase: "done",
      settingsStatus: "unknown",
      summary: "Exported 2 files to export/",
      measured: "Measured −16.1 LUFS, true peak −2.1 dBTP.",
    },
  },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Exported 2 files to export/")).toBeVisible();
    await expect(
      view.getByText("Current export settings could not be checked."),
    ).toBeVisible();
    await expect(
      view.getByText("Measured −16.1 LUFS, true peak −2.1 dBTP."),
    ).toBeVisible();
    await expect(
      view.getByRole("link", { name: /^Download field-notes\.mp3/ }),
    ).toBeVisible();
    await expect(
      view.getByRole("link", { name: /^Download field-notes\.wav/ }),
    ).toBeVisible();
    await expect(
      view.getByRole("button", { name: "Copy listen link" }),
    ).toBeEnabled();
    await expect(canvasElement.querySelector("[data-highlight]")).toBeNull();
  }),
};

export const Stale: Story = {
  args: { exportState: STALE, link: { url: LINK } },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Edited since export")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Export again" }));
    await expect(args.onExport).toHaveBeenCalledOnce();
  }),
};

export const Failed: Story = {
  args: { exportState: FAILED },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Export failed")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: /^Export/ }));
    await expect(args.onExport).toHaveBeenCalledOnce();
  }),
};

export const EditedAfterExport: Story = {
  args: {
    exportState: DONE,
    files: exportedFilesOf(REQUEST, "reveal"),
    facts: MEASURED_FACTS,
  },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: /^Export again$/ }),
    ).toBeEnabled();
    await expect(view.getByText("Exported")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: /^Streaming/ }));
    await expect(view.getByText("Export is out of date")).toBeInTheDocument();
    await expect(view.getByRole("button", { name: /^Export$/ })).toBeEnabled();
    await expect(
      view.getByRole("button", { name: /^Reveal field-notes\.mp3/ }),
    ).toBeEnabled();
  }),
};

export const NeedsModel: Story = {
  args: { exportState: NEEDS_MODEL },
  decorators: [withModels],
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: "Get the transcription model" }),
    ).toBeEnabled();
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
  }),
};

export const NoMix: Story = {
  args: {
    link: { url: null, noMix: true },
    facts: { ...CLEAR_FACTS, mixUpToDate: false },
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = {
  name: "Error",
  args: { state: "error" },
  play: playInCanvas(async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    );
    await expect(args.onRetry).toHaveBeenCalledOnce();
  }),
};

export const Guest: Story = {
  args: { guest: true },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Only the host can deliver"),
    ).toBeInTheDocument();
    await expect(view.queryByRole("button", { name: /^Export/ })).toBeNull();
  }),
};

export const Phone: Story = {
  args: { layout: "phone" },
  parameters: isolatedStoryParameters,
  play: playInCanvas(async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getAllByRole("button", { name: /^Export/ }),
    ).toHaveLength(1);
  }),
};

export const PhoneExported: Story = {
  args: {
    layout: "phone",
    exportState: DONE,
    files: exportedFilesOf(REQUEST, "download"),
    facts: MEASURED_FACTS,
    link: { url: LINK },
  },
  parameters: isolatedStoryParameters,
};
