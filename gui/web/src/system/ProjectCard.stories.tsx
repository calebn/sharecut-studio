import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ProjectCardList } from "./ProjectCard";
import { MISSING, PROJECTS } from "./projectCardFixtures";

const meta: Meta<typeof ProjectCardList> = {
  title: "System/ProjectCard",
  component: ProjectCardList,
  tags: ["autodocs"],
  args: {
    projects: PROJECTS,
    label: "Recent episodes",
    onOpen: fn(),
    onFind: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
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
          'One recent project. The card is one button named by the project, with its meta and stage chip as the description; the chip says where it opens. The first card carries the accent ring that Enter continues from (visual only). Arrows, Home and End move between cards with one tab stop. A card whose folder moved shows "Folder moved" and a Find… button beside it.\n\n**Motion.** Hover changes the border and fill with `--motion-hover`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ProjectCardList>;

export const Cards: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /^The garden episode/ }),
    );
    await expect(args.onOpen).toHaveBeenCalledWith("garden", "prepare");
  },
};
export const Rows: Story = { args: { variant: "row" } };
export const FolderMoved: Story = {
  args: { projects: [PROJECTS[0], MISSING] },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Find/ }));
    await expect(args.onFind).toHaveBeenCalledWith("moved");
    await expect(args.onOpen).not.toHaveBeenCalled();
  },
};
export const RowsFolderMoved: Story = {
  args: { variant: "row", projects: [PROJECTS[0], MISSING] },
};
