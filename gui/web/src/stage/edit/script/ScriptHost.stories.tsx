import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { scriptFrame } from "../../../stages/edit/scriptDemo";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
} from "../../../storybook/storyLayout";
import { episode } from "../../../test/episodeFixture";
import { episodeBeforeEach } from "../../../test/withEpisode";
import { ScriptHost, type ScriptHostProps } from "./ScriptHost";
import {
  loadingEpisode,
  longEpisode,
  noTranscriptEpisode,
  PLAYHEAD_SEC,
  splitLanesEpisode,
} from "./scriptHostFixtures";

const meta: Meta<ScriptHostProps> = {
  title: "Stages/Edit/ScriptHost",
  component: ScriptHost,
  beforeEach: episodeBeforeEach,
  render: (props) => (
    <div style={scriptFrame(props.layout === "phone" ? "22.5rem" : "100%")}>
      <ScriptHost {...props} />
    </div>
  ),
  parameters: {
    ...isolatedStoryParameters,
    ...portaledOverlayParameters,
    episode: { project: episode() },
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "The Script of the Edit stage: the project's transcript from the store, drawn by the System Script pane and wired to the editing commands. A click places the caret and seeks, Shift and the arrows select, and the selection goes to the store as a track range (or a time range when it crosses tracks). Fix text opens on Enter, F2 or a double-click and commits one correction; the speaker's name opens the speaker popover; Find searches the whole transcript and its Replace all runs through the preview. The playhead is followed until the reader scrolls, and Back to playhead returns. Past 150 turns the host hands the pane a window of turns around the playhead or the reader.\n\nWhat a person may do is set by the callbacks the host gives the pane. A Viewer reads and seeks; a Commenter also selects; an Edit link selects but cannot Fix text, Replace or change speakers, which stay with the host. The statuses Loading and No transcript come from the store; Transcribing and Out of date come from the `status` prop, because the store has no source for them yet. The host has no error state of its own: a transcript that fails to load is the stage's load failure, which the frame draws.\n\n**Motion.** None. The playing underline and selection are static.",
      },
    },
  },
  globals: { viewport: { value: "desktop", isRotated: false } },
};

export default meta;
type Story = StoryObj<ScriptHostProps>;

const phone = {
  args: { layout: "phone" },
  globals: { viewport: { value: "mobile360", isRotated: false } },
} as const;

const word = (canvas: ReturnType<typeof within>, name: RegExp | string) =>
  canvas.findByRole("button", { name });

export const Reading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await word(canvas, /^Welcome/)).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: /, change speaker$/ }).length,
    ).toBeGreaterThan(0);
    await expect(
      canvas.getByRole("button", { name: /unsure words?, go to the next/ }),
    ).toBeVisible();
  },
};

export const Playing: Story = {
  parameters: {
    episode: {
      project: episode(),
      state: { playheadSec: PLAYHEAD_SEC, transcriptFollowPlayhead: true },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        within(canvasElement).getAllByRole("button", { current: true }),
      ).toHaveLength(1),
    );
  },
};

export const Selected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await word(canvas, /^Welcome/));
    await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowRight}{/Shift}");
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(".sys-script-word[data-selected]"),
      ).toHaveLength(3),
    );
  },
};

const openFix = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(await word(canvas, /^Welcome/));
  await userEvent.keyboard("{Enter}");
  await expect(
    await canvas.findByRole("textbox", { name: /^Fix text/ }),
  ).toHaveFocus();
};

export const FixText: Story = {
  play: async ({ canvasElement }) => openFix(canvasElement),
};

export const FixTextPhone: Story = {
  ...phone,
  play: async ({ canvasElement }) => openFix(canvasElement),
};

export const Find: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Find in transcript" }),
    );
    const field = await canvas.findByRole("searchbox", { name: "Find" });
    await userEvent.type(field, "the");
    await waitFor(() =>
      expect(canvas.getByRole("search")).toHaveTextContent(/\d+ of \d+/),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Show replace" }));
    await expect(
      await canvas.findByRole("button", { name: "Replace all" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Replace" })).toBeNull();
  },
};

export const Speaker: Story = {
  parameters: { episode: { project: splitLanesEpisode(episode()) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [name] = await canvas.findAllByRole("button", {
      name: "Mira, change speaker",
    });
    await userEvent.click(name);
    await expect(
      await within(document.body).findByRole("radio", { name: /Mira/ }),
    ).toBeChecked();
    await waitFor(() =>
      expect(
        within(document.body).getByRole("radio", { name: /Tomas/ }),
      ).toBeVisible(),
    );
  },
};

const guestPlay = async (
  { canvasElement }: { canvasElement: HTMLElement },
  speakers: boolean,
) => {
  const canvas = within(canvasElement);
  await expect(await word(canvas, /^Welcome/)).toBeVisible();
  await expect(
    canvas.queryAllByRole("button", { name: /, change speaker$/ }).length > 0,
  ).toBe(speakers);
  await userEvent.dblClick(await word(canvas, /^Welcome/));
  await expect(canvas.queryByRole("textbox")).toBeNull();
};

export const GuestViewer: Story = {
  parameters: { episode: { project: episode(), role: "viewer" } },
  play: async (context) => {
    await guestPlay(context, false);
    await expect(
      within(context.canvasElement).getByText("Read only"),
    ).toBeVisible();
  },
};

export const GuestCommenter: Story = {
  parameters: { episode: { project: episode(), role: "commenter" } },
  play: async (context) => {
    await guestPlay(context, false);
    await userEvent.click(
      await word(within(context.canvasElement), /^Welcome/),
    );
    await waitFor(() =>
      expect(
        context.canvasElement.querySelector(".sys-script-word[data-selected]"),
      ).not.toBeNull(),
    );
  },
};

export const EditShareGuest: Story = {
  parameters: { episode: { project: episode(), role: "editor" } },
  play: async (context) => {
    await guestPlay(context, true);
    const canvas = within(context.canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Find in transcript" }),
    );
    await canvas.findByRole("searchbox", { name: "Find" });
    await expect(
      canvas.queryByRole("button", { name: "Show replace" }),
    ).toBeNull();
  },
};

export const Loading: Story = {
  parameters: { episode: { project: loadingEpisode(episode()) } },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        within(canvasElement).queryByRole("button", { name: /^Welcome/ }),
      ).toBeNull(),
    );
    await expect(
      canvasElement.querySelector("[aria-busy='true']"),
    ).not.toBeNull();
  },
};

export const Empty: Story = {
  args: { onTranscribe: fn() },
  parameters: { episode: { project: noTranscriptEpisode(episode()) } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: /Transcribe/ }),
    );
    await expect(args.onTranscribe).toHaveBeenCalledOnce();
  },
};

export const Transcribing: Story = {
  args: {
    status: { kind: "transcribing", progress: 0.42, notYet: "12:00 to 52:10" },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/42/)).toBeVisible();
  },
};

export const OutOfDate: Story = {
  args: { status: { kind: "outOfDate", onUpdate: fn() } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: /Update/ }),
    ).toBeVisible();
  },
};

export const Windowed: Story = {
  parameters: { episode: { project: longEpisode(episode()) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole("group", { name: /, \d+:\d+$/ });
    const drawn = canvas.getAllByRole("group", { name: /, \d+:\d+$/ }).length;
    await expect(drawn).toBeGreaterThan(0);
    await expect(drawn).toBeLessThan(420);
  },
};

export const Phone: Story = {
  ...phone,
  play: async ({ canvasElement }) => {
    await expect(await word(within(canvasElement), /^Welcome/)).toBeVisible();
  },
};
