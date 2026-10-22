import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { joinVisual } from "../../edit/joinRender";
import { clipRow } from "../../test/fixtures";
import type { ClipRow } from "../../types/project";
import { JoinBlend } from "../JoinBlend";
import { timelineLaneStoryDecorator } from "../timelineLaneStoryDecorator";
import { EditMarkerLayer } from "./EditMarkerLayer";
import { collectJoinMarks, type PlacedChip, planLaneMarks } from "./plan";

type JoinSpec = {
  sec: number;
  mode: ClipRow["join_in_mode"];
  ms?: number;
  blocked?: ClipRow["join_crossfade_blocked"];
};

function chain(specs: JoinSpec[]): ClipRow[] {
  const rows: ClipRow[] = [];
  const startSec = Math.max(0, specs[0].sec - 1);
  rows.push(
    clipRow({
      id: "c0",
      source_start: startSec,
      source_end: specs[0].sec,
      timeline_start: startSec,
      timeline_end: specs[0].sec,
      source_duration_sec: 100,
    }),
  );
  specs.forEach((spec, i) => {
    const next = specs[i + 1]?.sec ?? spec.sec + 1;
    rows.push(
      clipRow({
        id: `c${i + 1}`,
        source_start: spec.sec,
        source_end: next,
        timeline_start: spec.sec,
        timeline_end: next,
        join_left_clip_id: `c${i}`,
        join_in_mode: spec.mode,
        join_crossfade_ms: spec.ms,
        join_crossfade_blocked: spec.blocked ?? null,
        source_duration_sec: 100,
      }),
    );
  });
  return rows;
}

function Lane({
  specs,
  zoomPxPerSec,
  onZoomChip,
}: {
  specs: JoinSpec[];
  zoomPxPerSec: number;
  onZoomChip: (chip: PlacedChip) => void;
}) {
  const clips = chain(specs);
  const plan = planLaneMarks(
    collectJoinMarks(clips, null, () => false),
    zoomPxPerSec,
    600,
  );
  return (
    <>
      {plan.symbols.map(({ mark }) => {
        return (
          <JoinBlend
            key={mark.id}
            visual={joinVisual(mark.right, zoomPxPerSec)}
            zoomPxPerSec={zoomPxPerSec}
          />
        );
      })}
      <EditMarkerLayer plan={plan} onZoomChip={onZoomChip} />
    </>
  );
}

const meta: Meta<typeof Lane> = {
  title: "Templates/EditMarkerLayer",
  component: Lane,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", lanePreviewLabel: "Edit marker preview" },
  decorators: [timelineLaneStoryDecorator],
  args: { zoomPxPerSec: 50, onZoomChip: fn() },
};

export default meta;
type Story = StoryObj<typeof Lane>;

export const AllTypes: Story = {
  args: {
    specs: [
      { sec: 2, mode: "cut" },
      { sec: 5, mode: "fade" },
      { sec: 8, mode: "crossfade", ms: 400 },
      { sec: 11, mode: "crossfade", ms: 400, blocked: "no_fade_in" },
    ],
    zoomPxPerSec: 40,
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".edit-mark")).toHaveLength(4);
    await expect(
      canvasElement.querySelectorAll(".edit-mark--blocked"),
    ).toHaveLength(1);
  },
};

export const NarrowOverlap: Story = {
  args: { specs: [{ sec: 3, mode: "crossfade", ms: 120 }] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".join-blend")).not.toBeNull();
    await expect(canvasElement.querySelector(".join-blend path")).toBeNull();
  },
};

export const WideOverlap: Story = {
  args: { specs: [{ sec: 3, mode: "crossfade", ms: 800 }] },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".join-blend path"),
    ).not.toBeNull();
  },
};

export const Chip: Story = {
  args: {
    specs: [
      { sec: 2, mode: "cut" },
      { sec: 2.1, mode: "cut" },
      { sec: 2.2, mode: "crossfade", ms: 100 },
      { sec: 9, mode: "fade" },
    ],
    zoomPxPerSec: 40,
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll(".edit-chip")).toHaveLength(1);
    await expect(canvasElement.querySelectorAll(".edit-mark")).toHaveLength(1);
    await expect(
      canvasElement.querySelector(".edit-chip")?.getAttribute("aria-label"),
    ).toBe("3 edits: 2 cuts, 1 crossfade. Zoom in");
  },
};

export const PhoneChip: Story = {
  ...Chip,
  parameters: { ...meta.parameters, phoneWidth: true },
};
