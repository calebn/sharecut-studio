import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState } from "react";
import { userEvent, within } from "storybook/test";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  enlargedLandscapeSheet,
  inspectorSheetStoryDecorator,
} from "../../test/inspectorSheetDecorator";
import type { ClipRow } from "../../types/project";
import { ClipInspector } from "./ClipInspector";

const clip: ClipRow = {
  id: "clip-story",
  track_id: "host",
  source_id: null,
  source_duration_sec: null,
  recording_key: null,
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
};

function ClipStory({ readOnly = false }: { readOnly?: boolean }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = useDawStore.getState();
    useDawStore.getState().hydrate(
      "share:clip-story",
      minimalProject({
        tracks: [
          sampleTrack({ id: "guest", label: "Guest track" }),
          sampleTrack({
            id: "host",
            label: "A long descriptive host track name",
          }),
        ],
        clips: { tracks: { host: [clip] }, clip_count: 1 },
      }),
    );
    useDawStore.setState({
      guestMode: readOnly ? "view" : "edit",
      shareCapabilities: readOnly ? ["view"] : ["edit"],
    });
    useDawStore
      .getState()
      .setSelection({ kind: "clip", id: clip.id, trackId: clip.track_id });
    setReady(true);
    return () => {
      useDawStore.setState(previous);
    };
  }, [readOnly]);
  return ready ? <ClipInspector clip={clip} /> : null;
}

const meta: Meta<typeof ClipInspector> = {
  title: "Templates/Clip inspector",
  component: ClipInspector,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof ClipInspector>;
export const EnlargedTextShortLandscape: Story = {
  ...enlargedLandscapeSheet,
  decorators: [inspectorSheetStoryDecorator],
  render: () => <ClipStory />,
};

export const PointerPlacement: Story = {
  render: () => <ClipStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Later 10 ms" }));
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Target track" }),
      "guest",
    );
  },
};
export const PlacementInputError: Story = {
  render: () => <ClipStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Move clip" }),
    );
    await userEvent.clear(canvas.getByLabelText("Timeline start (seconds)"));
  },
};
export const PlacementViewer: Story = { render: () => <ClipStory readOnly /> };
