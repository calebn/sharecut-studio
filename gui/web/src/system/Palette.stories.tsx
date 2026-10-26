import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Palette, type PaletteItem } from "./Palette";
import { verbPaletteItems } from "./paletteItems";

const extra: PaletteItem[] = [
  { id: "project:13", group: "Projects", label: "Episode 13", icon: "inbox" },
  {
    id: "person:rosa",
    group: "People",
    label: "Rosa Diaz",
    icon: "locate-fixed",
    context: "Follow",
  },
  {
    id: "chapter:2",
    group: "Chapters",
    label: "The long way round",
    icon: "flag",
    context: "26:05",
  },
  {
    id: "help:report",
    group: "Help",
    label: "Report a problem",
    icon: "message-square",
  },
];

const meta: Meta<typeof Palette> = {
  title: "System/Palette",
  component: Palette,
  tags: ["autodocs"],
  args: {
    items: [...verbPaletteItems(), ...extra],
    onRun: fn(),
    onClose: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{ padding: "1rem", display: "flex", justifyContent: "center" }}
      >
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
          "Search first; Recent when the query is empty. Rows show the verb icon, name, context and key caps, grouped as commands, stages, projects, people, chapters, gestures and Help. A host mounts it in a centered Dialog 20% from the top; on phone it is a full-height Sheet.\n\n**Motion.** Opens with `--motion-panel` (fade and rise); results change instantly. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Palette>;

export const Empty: Story = {};

export const Recent: Story = {
  args: { recent: ["verb:cut", "stage:review", "person:rosa"] },
};

export const Filtered: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole("combobox", { name: "Search commands" });
    await userEvent.type(search, "cut");
    await expect(canvas.getByRole("option", { name: /^Cut/ })).toBeVisible();
    await expect(canvas.queryByRole("option", { name: /^Mute/ })).toBeNull();
    await userEvent.keyboard("{Enter}");
    await expect(args.onRun).toHaveBeenCalled();
  },
};

export const NoMatches: Story = { args: { initialQuery: "zzz" } };

export const Phone: Story = {
  args: { form: "sheet" },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "36rem" }}>
        <Story />
      </div>
    ),
  ],
};
