import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { episode, MIRA, selections, TOMAS } from "../../test/episodeFixture";
import {
  enlargedLandscapeSheet,
  inspectorSheetStoryDecorator,
} from "../../test/inspectorSheetDecorator";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import { ClipInspector } from "./ClipInspector";

const project = episode();
const clip = project.clips.tracks[MIRA][0];

const meta: Meta<typeof ClipInspector> = {
  title: "Templates/Editor · Inspector · Clip",
  component: ClipInspector,
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <ClipInspector clip={clip} />,
  parameters: {
    layout: "fullscreen",
    episode: { project, role: "editor", selection: selections.clip },
  },
};
export default meta;
type Story = StoryObj<typeof ClipInspector>;
export const EnlargedTextShortLandscape: Story = {
  ...enlargedLandscapeSheet,
  decorators: [inspectorSheetStoryDecorator],
};

export const PointerPlacement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Later 10 ms" }));
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Target track" }),
      TOMAS,
    );
  },
};
export const PlacementInputError: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.clear(canvas.getByLabelText("Timeline start (seconds)"));
  },
};
export const PlacementViewer: Story = {
  parameters: {
    episode: { project, role: "viewer", selection: selections.clip },
  },
};
