import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { ClipsRow } from "./ClipsRow";
import { CLIPS } from "./deliverFixture";
import { approveClip, type Clip, removeClip } from "./deliverLogic";

function Live(props: React.ComponentProps<typeof ClipsRow>) {
  const [clips, setClips] = useState<readonly Clip[]>(props.clips);
  return (
    <ClipsRow
      {...props}
      clips={clips}
      onApprove={(id) => setClips(approveClip(clips, id))}
      onRemove={(id) => setClips(removeClip(clips, id))}
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
    onRetry: fn(),
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
          "Clip ideas as cards: play, a title edited in place, the length, one to three strength bars and Approve. Approved clips export with the episode and show up as files next to it. Trimming on the waveform and the more menu are not built in this slice.\n\n**Motion.** Animations come later: approving fills the card border with `--motion-hover`.",
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
      view.getAllByRole("button", { name: "Approve" })[0] as HTMLElement,
    );
    await expect(view.getAllByText("Approved")).toHaveLength(2);
    await userEvent.click(
      view.getByRole("button", { name: "Remove The boat was still there" }),
    );
    await expect(view.getAllByRole("listitem")).toHaveLength(2);
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

export const LoadError: Story = { name: "Error", args: { state: "error" } };

export const Phone: Story = {
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
