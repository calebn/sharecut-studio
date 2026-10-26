import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { ChaptersList } from "./ChaptersList";
import { CHAPTERS, TOTAL } from "./deliverFixture";
import {
  addChapterAt,
  type Chapter,
  removeChapter,
  retimeChapter,
  retitleChapter,
} from "./deliverLogic";

function Live(props: React.ComponentProps<typeof ChaptersList>) {
  const [chapters, setChapters] = useState<readonly Chapter[]>(props.chapters);
  return (
    <ChaptersList
      {...props}
      chapters={chapters}
      onRetitle={(id, title) =>
        setChapters(retitleChapter(chapters, id, title))
      }
      onRetime={(id, at) => setChapters(retimeChapter(chapters, id, at))}
      onRemove={(id) => setChapters(removeChapter(chapters, id))}
      onAdd={() => setChapters(addChapterAt(chapters, 724, "added"))}
    />
  );
}

const meta: Meta<typeof ChaptersList> = {
  title: "Stages/Deliver/Chapters",
  component: ChaptersList,
  tags: ["autodocs"],
  render: (args) => <Live {...args} />,
  args: {
    chapters: CHAPTERS,
    total: TOTAL,
    onRetitle: fn(),
    onRetime: fn(),
    onPlayFrom: fn(),
    onRemove: fn(),
    onAdd: fn(),
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
          "Chapters as 44 px rows: a time you can scrub or type, a title edited in place, play from here and delete. Add at playhead sits at the end. In Edit the same chapters stay draggable markers.\n\n**Motion.** Animations come later: a new row slides in and a deleted one collapses with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ChaptersList>;

export const List: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Play from The old mill" }),
    );
    await expect(args.onPlayFrom).toHaveBeenCalledWith(312.4);
    await userEvent.click(
      view.getByRole("button", { name: "Add at playhead" }),
    );
    await expect(view.getAllByRole("listitem")).toHaveLength(5);
    await userEvent.click(
      view.getByRole("button", { name: "Delete Listener mail" }),
    );
    await expect(view.getAllByRole("listitem")).toHaveLength(4);
  },
};

export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = view.getByRole("textbox", { name: "Title of Cold open" });
    await userEvent.clear(title);
    await userEvent.type(title, "Welcome");
    await expect(title).toHaveValue("Welcome");
    const time = view.getByRole("textbox", { name: /^Time of The old mill/ });
    await userEvent.clear(time);
    await userEvent.type(time, "6:00{Enter}");
    await expect(time).toHaveValue("6:00.0");
  },
};

export const Empty: Story = {
  args: { chapters: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Add at playhead" }),
    ).toBeInTheDocument();
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
