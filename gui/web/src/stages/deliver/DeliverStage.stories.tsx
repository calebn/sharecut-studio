import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  isolatedStoryParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { playInCanvas } from "../../storybook/storyPlay";
import { isApplePlatform } from "../../utils/platform";
import { BOUNCE_DEFAULTS } from "./bounceLogic";
import { DeliverStage, type DeliverStageProps } from "./DeliverStage";
import {
  CHAPTERS,
  CLEAR_FACTS,
  CLIPS,
  DONE,
  exportedState,
  FAILED,
  MEASURED_FACTS,
  NEEDS_MODEL,
  NEVER,
  OPEN_FACTS,
  RUNNING,
  SETTINGS,
  STALE,
  TOTAL,
} from "./deliverFixture";
import {
  AGENT_ROW,
  GUEST_ROW,
  ONLINE,
  PRODUCER_ROW,
  REVIEW_ROW,
  shareOptions,
} from "./shareFixture";

const MOD_E = isApplePlatform() ? "{Meta>}e{/Meta}" : "{Control>}e{/Control}";
const REVEAL = isApplePlatform() ? "Reveal in Finder" : "Show in folder";

/** Exports and copies in place, as the app will once it is wired. */
function Live(props: DeliverStageProps) {
  const [exportState, setExportState] = useState(props.exportState);
  return (
    <DeliverStage
      {...props}
      exportState={exportState}
      onExport={(request) => {
        props.onExport(request);
        setExportState(exportedState(request));
      }}
    />
  );
}

const meta: Meta<typeof DeliverStage> = {
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
    env: "app",
    clock: { time: "12:04", total: "52:00" },
    playhead: 724,
    toastMs: 600_000,
    onFix: fn(),
    onExport: fn(),
    onCancel: fn(),
    onReveal: fn(),
    onDownload: fn(),
    onChangeFolder: fn(),
    onPlayFrom: fn(),
    onPlayClip: fn(),
    onFindClips: fn(),
    onOpenClipInEdit: fn(),
    onGetModel: fn(),
    onRetry: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Deliver: Readiness first, then the episode file, Bounce, Share, chapters and clips. Export is the only filled button; after it, Reveal in Finder (app) or Download all (browser) takes its place and Copy on a listen link is the follow-up. Nothing in Readiness blocks Export. Mod+E exports. Presentational: the export job, the links and the data come in as props, and the buttons call back.\n\n**Motion.** Animations come later: the export progress and the Reveal swap use `--motion-panel`, the copied label holds for 2 s.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DeliverStage>;

export const Ready: Story = {
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Ready to export")).toBeInTheDocument();
    await userEvent.keyboard(MOD_E);
    await expect(args.onExport).not.toHaveBeenCalled();
    canvasElement.querySelector<HTMLElement>(".dv-stage")?.focus();
    await userEvent.keyboard(MOD_E);
    await expect(args.onExport).toHaveBeenCalledOnce();
    await expect(
      await view.findByRole("button", { name: REVEAL }),
    ).toBeInTheDocument();
    await expect(view.queryByRole("button", { name: /^Export/ })).toBeNull();
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
    facts: MEASURED_FACTS,
    share: shareOptions(fn, { rows: [REVIEW_ROW] }),
  },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: REVEAL }));
    await expect(args.onReveal).toHaveBeenCalledOnce();
    await userEvent.click(view.getByRole("button", { name: "Copy" }));
    await expect(args.share?.onCopy).toHaveBeenCalledOnce();
  }),
};

export const ExportedInBrowser: Story = {
  args: { exportState: DONE, env: "browser", facts: MEASURED_FACTS },
  play: playInCanvas(async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Download all" }),
    ).toBeInTheDocument();
  }),
};

export const Stale: Story = {
  args: { exportState: STALE },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Edited since export")).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: /^Export/ }));
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
  args: { exportState: DONE, facts: MEASURED_FACTS },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole("button", { name: /^Export/ })).toBeNull();
    await userEvent.click(view.getByRole("button", { name: /^Streaming/ }));
    await expect(view.getByText("Edited since export")).toBeInTheDocument();
    await expect(view.getByRole("button", { name: /^Export/ })).toBeEnabled();
    await expect(view.queryByRole("button", { name: REVEAL })).toBeNull();
  }),
};

export const NeedsModel: Story = {
  args: { exportState: NEEDS_MODEL },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Get" }));
    await expect(args.onGetModel).toHaveBeenCalledOnce();
    await expect(view.getByRole("button", { name: /^Export/ })).toBeDisabled();
  }),
};

export const NoMix: Story = {
  args: {
    facts: { ...CLEAR_FACTS, mixUpToDate: false },
    share: shareOptions(fn, {
      createRecovery: {
        kind: "needs_refresh",
        message:
          "This project has no mix yet. Refresh the mix to create the link.",
        refreshError: null,
      },
    }),
  },
  play: playInCanvas(async ({ canvasElement, args }) => {
    await userEvent.click(
      within(
        within(canvasElement).getByRole("region", { name: "Share" }),
      ).getByRole("button", { name: "Refresh mix" }),
    );
    await expect(args.share?.onRefreshMix).toHaveBeenCalledOnce();
  }),
};

export const WithShare: Story = {
  args: {
    share: shareOptions(fn, {
      rows: [REVIEW_ROW, AGENT_ROW, GUEST_ROW, PRODUCER_ROW],
      tunnel: ONLINE,
      reach: "anywhere",
    }),
  },
  play: playInCanvas(async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("heading", { name: "Share" })).toBeVisible();
    await userEvent.click(
      view.getByRole("button", { name: "Create review link" }),
    );
    await expect(args.share?.onCreate).toHaveBeenCalledOnce();
  }),
};

export const WithBounce: Story = {
  args: {
    bounce: {
      state: { phase: "idle" },
      choices: BOUNCE_DEFAULTS,
      onChoices: fn(),
      selectedCount: 0,
      soloCount: 0,
      hasRegion: false,
      onBounce: fn(),
      onCancel: fn(),
    },
  },
  play: playInCanvas(async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("heading", { name: "Bounce" })).toBeVisible();
    await expect(
      view.getByRole("button", { name: "Entire mix" }),
    ).toHaveAttribute("aria-pressed", "true");
  }),
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
    env: "browser",
    facts: MEASURED_FACTS,
    share: shareOptions(fn, { rows: [REVIEW_ROW], reach: "network" }),
  },
  parameters: isolatedStoryParameters,
};
