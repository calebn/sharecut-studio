import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { HomeView } from "./HomeView";
import { RECENTS, RECENTS_MOVED } from "./homeFixture";

const meta: Meta<typeof HomeView> = {
  title: "Stages/Home/Home",
  component: HomeView,
  tags: ["autodocs"],
  args: {
    phase: "ready",
    projects: RECENTS,
    setup: null,
    showInstallHint: false,
    dropActive: false,
    onOpenProject: fn(),
    onFindProject: fn(),
    onImport: fn(),
    onRecord: fn(),
    onOpenOther: fn(),
    onGetReady: fn(),
    onChooseModels: fn(),
    onCancelSetup: fn(),
    onRetrySetup: fn(),
    onDismissSetup: fn(),
    onDismissHint: fn(),
    onHelp: fn(),
    onModels: fn(),
    onConnectAgent: fn(),
    onSettings: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "Home: the Import audio and Record tiles over the recent episodes, with the Setup card between them and Recent when models are missing, and the Add to Home Screen hint at the top of Recent. Below 40rem the tiles become a 72 px bar in the thumb zone and the cards become 72 px rows. Presentational: data in, callbacks out.\n\nNot built here: the card context menu (Open, Reveal in folder, Duplicate, Remove from list) and the phone swipe-to-remove. Both need the real remove-from-list action, so they are deferred to wiring.\n\n**Motion.** Hover and drag-hover use `--motion-hover`; the Setup card leaves with `--motion-panel` when dismissed.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof HomeView>;

export const Empty: Story = { args: { phase: "empty", projects: [] } };
export const WithRecents: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Rosa and Maya, week 42" }),
    );
    await expect(args.onOpenProject).toHaveBeenCalledWith("rosa", "review");
  },
};
export const SetupNeeded: Story = {
  args: { setup: { state: "needed", sizeLabel: "about 2 GB" } },
};
export const SetupDownloading: Story = {
  args: {
    setup: {
      state: "downloading",
      sizeLabel: "about 2 GB",
      progress: 0.55,
      detail: "1.1 of 2.0 GB · about 3 min",
    },
  },
};
export const FolderMoved: Story = { args: { projects: RECENTS_MOVED } };
export const DropHover: Story = { args: { dropActive: true } };
export const Loading: Story = {
  args: { phase: "loading", projects: [], loadingElapsedMs: 1000 },
};
export const PhoneInstallHint: Story = { args: { showInstallHint: true } };
