import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState } from "react";
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
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
};

function ClipStory() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = useDawStore.getState();
    useDawStore.getState().hydrate(
      "share:clip-story",
      minimalProject({
        tracks: [
          sampleTrack({
            id: "host",
            label: "A long descriptive host track name",
          }),
        ],
        clips: { tracks: { host: [clip] }, clip_count: 1 },
      }),
    );
    setReady(true);
    return () => {
      useDawStore.setState(previous);
    };
  }, []);
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
