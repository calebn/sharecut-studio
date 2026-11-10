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

const denseClips = Array.from({ length: 8 }, (_, i) =>
  clipRow({
    id: `d${i}`,
    track_id: TRACK,
    source_start: i * 0.3,
    source_end: (i + 1) * 0.3,
    timeline_start: i * 0.3,
    timeline_end: (i + 1) * 0.3,
    source_duration_sec: 60,
  }),
);

function Seeded({
  children,
  rows,
}: {
  children: ReactNode;
  rows: typeof clips;
}) {
  useState(() => {
    useDawStore.setState({
      project: minimalProject({
        clips: { tracks: { [TRACK]: rows }, clip_count: rows.length },
        edit_boundaries: editBoundaries(rows),
      }),
      selection: null,
    });
  });
  return <>{children}</>;
}

function Lane({
  onSelect,
  rows = clips,
}: {
  onSelect: (id: string) => void;
  rows?: typeof clips;
}) {
  const [preview, setPreview] = useState<RollPreview | null>(null);
  return (
    <Seeded rows={rows}>
      <div style={{ position: "relative", blockSize: "3rem" }}>
        <SeamLayer
          trackId={TRACK}
          zoomPxPerSec={40}
          rollPreview={preview}
          onRollPreview={setPreview}
          isMoving={() => false}
          onSelectSeam={onSelect}
        />
      </div>
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
    await fireEvent.pointerDown(hit, { pointerId: 1, button: 0, clientX: 160 });
    await fireEvent.pointerMove(hit, { pointerId: 1, clientX: 180 });
    await expect(
      canvasElement.querySelector(".sys-seam-readout"),
    ).toHaveTextContent("+500 ms");
    await fireEvent.pointerCancel(hit, { pointerId: 1 });
  },
};

export const DenseSeams: Story = {
  args: { rows: denseClips },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getAllByRole("button", { name: /^Split at/ }),
    ).toHaveLength(7);
  },
};
