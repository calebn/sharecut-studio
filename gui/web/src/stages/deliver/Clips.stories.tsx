import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, screen, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { ClipsRow } from "./ClipsRow";
import { CLIPS, PEAKS, TOTAL, WORDS } from "./deliverFixture";
import { approveClip, type Clip, removeClip, trimClip } from "./deliverLogic";

function Live(props: React.ComponentProps<typeof ClipsRow>) {
  const [clips, setClips] = useState<readonly Clip[]>(props.clips);
  return (
    <ClipsRow
      {...props}
      clips={clips}
      onApprove={(id) => setClips(approveClip(clips, id))}
      onRemove={(id) => setClips(removeClip(clips, id))}
      onTrim={(id, edge, at) =>
        setClips(trimClip(clips, id, edge, at, props.total))
      }
    />
  );
}

const meta: Meta<typeof ClipsRow> = {
  title: "Stages/Deliver/Clips",
  component: ClipsRow,
  tags: ["autodocs"],
  render: (args) => <Live {...args} />,
  args: {
    clips: CLIPS,
    onRetitle: fn(),
    onPlay: fn(),
    onApprove: fn(),
    onRemove: fn(),
    onFind: fn(),
    onTrim: fn(),
    onOpenInEdit: fn(),
    total: TOTAL,
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
          "Clip ideas as cards: play, a title edited in place, the length, one to three strength bars and Approve. Approved clips export with the episode and show up as files next to it. Trim opens a waveform strip with In and Out handles, and the In and Out fields. Handles snap to word starts and ends when the host passes words; hold Alt to move freely. Left and Right move one word, Shift ten words, Alt 10 ms. Without words the handles move freely.\n\n**Motion.** Animations come later: approving fills the card border with `--motion-hover`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ClipsRow>;

export const Suggested: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByRole("img", { name: /clip$/ })).toHaveLength(3);
    await userEvent.click(
      view.getAllByRole("button", { name: /^Approve/ })[0] as HTMLElement,
    );
    await expect(view.getAllByText("Approved")).toHaveLength(2);
    await userEvent.click(
      view.getByRole("button", { name: "More for The boat was still there" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    await expect(view.getAllByRole("listitem")).toHaveLength(2);
  },
};

export const Trimming: Story = {
  args: { trimming: "k1" },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const out = view.getByRole("textbox", {
      name: "Out of Nobody asked the river",
    });
    await expect(out).toHaveValue("10:53.0");
    await userEvent.clear(out);
    await userEvent.type(out, "10:50{Enter}");
    await expect(out).toHaveValue("10:50.0");
    await expect(view.getByText("38.0 s")).toBeInTheDocument();
  },
};

export const TrimmingWithWords: Story = {
  args: { trimming: "k1", words: WORDS, peaks: PEAKS },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const handle = view.getByRole("slider", {
      name: "In handle of Nobody asked the river",
    });
    const before = handle.getAttribute("aria-valuenow");
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(handle.getAttribute("aria-valuenow")).not.toBe(before);
    await expect(
      view.getByRole("textbox", { name: "In of Nobody asked the river" }),
    ).not.toHaveValue("10:12.0");
  },
};

export const TrimmingNoWords: Story = {
  args: { trimming: "k1", peaks: PEAKS },
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole("slider", {
      name: "Out handle of Nobody asked the river",
    });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(handle).toHaveAttribute("aria-valuenow", "652.99");
  },
};

export const TrimmingNoData: Story = {
  args: { trimming: "k1" },
};

export const TrimmingPhone: Story = {
  args: { trimming: "k1", words: WORDS, peaks: PEAKS },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};

export const TrimmingDark: Story = {
  args: { trimming: "k1", words: WORDS, peaks: PEAKS },
  globals: { theme: "dark" },
};

export const Approved: Story = {
  args: { clips: CLIPS.map((clip) => ({ ...clip, approved: true })) },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByText("Approved")).toHaveLength(3);
    await expect(view.queryByRole("button", { name: /^Approve/ })).toBeNull();
  },
};

export const OpenInEdit: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "More for Cold open" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open in Edit" }),
    );
    await expect(args.onOpenInEdit).toHaveBeenCalledWith("k3");
  },
};

export const Empty: Story = {
  args: { clips: [] },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Find clips" }),
    );
    await expect(args.onFind).toHaveBeenCalledOnce();
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
