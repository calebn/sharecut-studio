import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useState } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import type { RollPreview } from "../edit/clipEdgePreview";
import { useDawStore } from "../state/dawStore";
import { portaledOverlayParameters } from "../storybook/storyLayout";
import { clipRow, editBoundaries, minimalProject } from "../test/fixtures";
import { SeamLayer } from "./SeamLayer";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

const TRACK = "mira-voice";

const clips = [
  clipRow({
    id: "a",
    track_id: TRACK,
    source_start: 0,
    source_end: 4,
    timeline_start: 0,
    timeline_end: 4,
    source_duration_sec: 60,
  }),
  clipRow({
    id: "b",
    track_id: TRACK,
    source_start: 4,
    source_end: 9,
    timeline_start: 4,
    timeline_end: 9,
    source_duration_sec: 60,
  }),
  clipRow({
    id: "c",
    track_id: TRACK,
    source_start: 12,
    source_end: 16,
    timeline_start: 9,
    timeline_end: 13,
    source_duration_sec: 60,
  }),
];

function Seeded({ children }: { children: ReactNode }) {
  useState(() => {
    useDawStore.setState({
      project: minimalProject({
        clips: { tracks: { [TRACK]: clips }, clip_count: clips.length },
        edit_boundaries: editBoundaries(clips),
      }),
      selection: null,
    });
  });
  return <>{children}</>;
}

function Lane({ onSelect }: { onSelect: (id: string) => void }) {
  const [preview, setPreview] = useState<RollPreview | null>(null);
  return (
    <Seeded>
      <SeamLayer
        trackId={TRACK}
        zoomPxPerSec={40}
        rollPreview={preview}
        onRollPreview={setPreview}
        isMoving={() => false}
        onSelectSeam={onSelect}
      />
    </Seeded>
  );
}

const meta: Meta<typeof Lane> = {
  title: "Templates/SeamLayer",
  component: Lane,
  tags: ["autodocs"],
  parameters: {
    ...portaledOverlayParameters,
    layout: "fullscreen",
    lanePreviewLabel: "Seam diamonds on a lane",
  },
  decorators: [timelineLaneStoryDecorator],
  args: { onSelect: fn() },
};

export default meta;
type Story = StoryObj<typeof Lane>;

export const SeamKinds: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: /^Split at 0:04\.0/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: /^Cut at 0:09\.0/ }),
    ).toBeVisible();
  },
};

export const SelectBySeam: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /^Split at 0:04\.0/ }),
    );
    await expect(args.onSelect).toHaveBeenCalledWith("eb:a:b");
  },
};

export const Rolling: Story = {
  play: async ({ canvasElement }) => {
    const hit = within(canvasElement).getByRole("button", {
      name: /^Split at 0:04\.0/,
    });
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, clientX: 160 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 180 });
    await expect(
      canvasElement.querySelector(".sys-seam-readout"),
    ).toHaveTextContent("+500 ms");
    fireEvent.pointerCancel(hit, { pointerId: 1 });
  },
};
