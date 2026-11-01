import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { clamp } from "../utils/math";
import {
  ALL_KINDS,
  DENSE,
  EPISODE_SECONDS,
  NESTED,
  STACKED_START,
  stage,
  WIDE,
} from "./laneFixtures";
import { LanesBelow, Measured } from "./laneStoryHost";
import {
  type AddingChapter as AddingChapterAt,
  type LaneMarker,
  MARKER_MIN_SPAN,
  type MarkerGrip,
  MarkerLane,
  type MarkerLaneProps,
} from "./MarkerLane";
import { Ruler } from "./Ruler";

const noop = () => undefined;

const meta: Meta<typeof MarkerLane> = {
  title: "System/MarkerLane",
  component: MarkerLane,
  tags: ["autodocs"],
  args: {
    markers: ALL_KINDS,
    authoritativeMarkers: ALL_KINDS,
    start: 0,
    pxPerSecond: 6,
    width: 360,
    duration: EPISODE_SECONDS,
    onSelect: fn(),
    onDragStart: fn(),
    onDrag: fn(),
    onDragEnd: fn(),
    onNudge: fn(),
    onNudgeEnd: fn(),
    onAdd: fn(),
    onAddCommit: fn(),
    onAddCancel: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The marker lane (design-system element 18a): one 24 px lane for chapters, comments and social clips, on plain data and the same `start`, `pxPerSecond` and `width` as the ruler above it. A chapter is a 12 px flag in the chapter token with its title inline, cut off at the next marker. A comment is a 16 px speech-bubble pin with the author's initial, and a range comment adds a 3 px bar. A social clip is a `[ ]` bracket pair in the social token joined by a 2 px line, hatched while proposed. Hover or focus shows the title and time. Markers whose drawings overlap fold into one: the earliest stays and a `+N` chip after it opens a list of the rest.\n\nA click or Enter selects (`onSelect(id, additive)`). A drag on a chapter, on a bracket, or on a bracket's edge moves it: `onDragStart` (return `false` to refuse), `onDrag` with the pointer, Shift, Alt and the seconds moved, and `onDragEnd`, which reports `committed: false` for Escape, a window blur, `pointercancel`, a lost capture or the marker leaving the lane. The lane draws a readout chip from the marker's current time, so a host that snaps shows the snapped time. A double-click on an empty part of the lane asks for a chapter (`onAdd`); the host then passes `adding` and the lane shows the name field, which commits on Enter (`onAddCommit`) and cancels on Escape (`onAddCancel`). A guest cannot drag or add.\n\nTab walks the markers in time order. Left and Right on a selected chapter or bracket nudge it 0.1 s (Shift 1 s) with `onNudge` and `onNudgeEnd`; Alt with Left or Right walks a selected bracket's focus to its edge sliders. Delete is the host's.\n\nUnder a coarse pointer a marker's touch area is 44 px wide and the lane's full 24 px tall, reaching only half the gap to its neighbour so it never covers the ruler above, the lanes below or another marker. A finger grabs a selected marker only; on an unselected one it pans the lane.\n\n**Motion.** None. Selection and the tip appear without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MarkerLane>;

type Origin = { start: number; end: number };

function moved(
  marker: LaneMarker,
  grip: MarkerGrip,
  delta: number,
  from: Origin,
) {
  const end = (value: number) => Math.max(0, value);
  if (marker.kind === "chapter") {
    return { ...marker, start: end(from.start + delta) };
  }
  if (marker.kind !== "clip") return marker;
  switch (grip) {
    case "move":
      return {
        ...marker,
        start: end(from.start + delta),
        end: end(from.end + delta),
      };
    case "start":
      return {
        ...marker,
        start: clamp(from.start + delta, 0, from.end - MARKER_MIN_SPAN),
      };
    case "end":
      return {
        ...marker,
        end: clamp(
          from.end + delta,
          from.start + MARKER_MIN_SPAN,
          EPISODE_SECONDS,
        ),
      };
  }
}

type LiveProps = {
  args: MarkerLaneProps;
  markers?: readonly LaneMarker[];
  selected?: readonly string[];
  window?: { start: number; pxPerSecond: number };
  touch?: boolean;
  readOnly?: boolean;
  adding?: AddingChapterAt | null;
  withRuler?: boolean;
};

function LiveLane({
  args,
  markers: first = ALL_KINDS,
  selected: selectedFirst = [],
  window: view = { start: 0, pxPerSecond: 6 },
  touch,
  readOnly,
  adding: addingFirst = null,
  withRuler,
}: LiveProps) {
  const [markers, setMarkers] = useState(first);
  const [preview, setPreview] = useState<readonly LaneMarker[] | null>(null);
  const [selected, setSelected] = useState(selectedFirst);
  const [adding, setAdding] = useState(addingFirst);
  const origin = useRef<Origin>({ start: 0, end: 0 });
  const edit = (id: string, change: (marker: LaneMarker) => LaneMarker) =>
    setPreview((now) =>
      (now ?? markers).map((marker) =>
        marker.id === id ? change(marker) : marker,
      ),
    );
  return (
    <div style={stage}>
      <Measured>
        {(width) => (
          <>
            {withRuler ? (
              <Ruler
                start={view.start}
                pxPerSecond={view.pxPerSecond}
                width={width}
                duration={EPISODE_SECONDS}
                playhead={view.start + 4}
                onSeek={noop}
              />
            ) : null}
            <MarkerLane
              {...args}
              markers={preview ?? markers}
              authoritativeMarkers={markers}
              selected={selected}
              start={view.start}
              pxPerSecond={view.pxPerSecond}
              width={width}
              touch={touch}
              readOnly={readOnly}
              adding={adding}
              onSelect={(id, additive) => {
                setSelected((now) =>
                  additive ? [...now.filter((x) => x !== id), id] : [id],
                );
                args.onSelect(id, additive);
              }}
              onDragStart={(id, grip, pointer) => {
                const marker = markers.find((m) => m.id === id);
                if (marker) {
                  origin.current = {
                    start: marker.start,
                    end:
                      marker.kind === "chapter"
                        ? marker.start
                        : (marker.end ?? marker.start),
                  };
                }
                setSelected([id]);
                return args.onDragStart?.(id, grip, pointer);
              }}
              onDrag={(id, grip, drag) => {
                edit(id, (marker) =>
                  moved(marker, grip, drag.delta, origin.current),
                );
                args.onDrag?.(id, grip, drag);
              }}
              onDragEnd={(id, grip, committed) => {
                if (committed && preview) setMarkers(preview);
                setPreview(null);
                args.onDragEnd?.(id, grip, committed);
              }}
              onNudge={(id, grip, seconds, nudge) => {
                edit(id, (marker) =>
                  moved(marker, grip, seconds, {
                    start: marker.start,
                    end:
                      marker.kind === "chapter"
                        ? marker.start
                        : (marker.end ?? marker.start),
                  }),
                );
                args.onNudge?.(id, grip, seconds, nudge);
              }}
              onNudgeEnd={(id, grip, committed) => {
                if (committed && preview) setMarkers(preview);
                setPreview(null);
                args.onNudgeEnd?.(id, grip, committed);
              }}
              onAdd={(seconds) => {
                setAdding({ at: seconds });
                args.onAdd?.(seconds);
              }}
              onAddCommit={(seconds, title) => {
                setMarkers((now) => [
                  ...now,
                  {
                    kind: "chapter",
                    id: `new-${seconds}`,
                    start: seconds,
                    title,
                  },
                ]);
                setAdding(null);
                args.onAddCommit?.(seconds, title);
              }}
              onAddCancel={() => {
                setAdding(null);
                args.onAddCancel?.();
              }}
            />
            <LanesBelow width={width} />
          </>
        )}
      </Measured>
    </div>
  );
}

const hit = (canvas: ReturnType<typeof within>, name: RegExp) =>
  canvas.getByRole("button", { name });

export const AllKinds: Story = {
  render: (args) => <LiveLane args={args} withRuler />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(hit(canvas, /^Chapter Cold open/)).toBeVisible();
    await expect(hit(canvas, /^Comment by Maya/)).toBeVisible();
    await expect(hit(canvas, /^Comment by Anneke/)).toBeVisible();
    await expect(hit(canvas, /^Clip idea Best joke, approved/)).toBeVisible();
    await expect(hit(canvas, /^Clip idea Tight intro, proposed/)).toBeVisible();
    await expect(hit(canvas, /^Chapter Interview/)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

export const Selecting: Story = {
  render: (args) => <LiveLane args={args} withRuler />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(hit(canvas, /^Chapter Interview/));
    await userEvent.unhover(hit(canvas, /^Chapter Interview/));
    await expect(args.onSelect).toHaveBeenCalledWith("ch-interview", false);
    await expect(hit(canvas, /^Chapter Interview/)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const Dense: Story = {
  args: { markers: DENSE },
  render: (args) => <LiveLane args={args} markers={DENSE} withRuler />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getAllByRole("button", { name: /more markers?$/ })[0];
    if (!chip) throw new Error("No stack chip");
    await userEvent.click(chip);
    const rows = within(document.body).getAllByRole("menuitem");
    await expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    if (!first) throw new Error("No list row");
    await userEvent.click(first);
    await expect(args.onSelect).toHaveBeenCalledTimes(1);
  },
};

export const Selected: Story = {
  render: (args) => <LiveLane args={args} selected={["sc-joke"]} withRuler />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(hit(canvas, /^Clip idea Best joke/)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      canvas.getByRole("slider", { name: "Start of Best joke" }),
    ).toHaveAttribute("aria-valuenow", "30");
  },
};

export const Dragging: Story = {
  render: (args) => <LiveLane args={args} selected={["ch-interview"]} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: /^Chapter Interview/ }),
    ).toHaveAttribute("data-movable", "true");
  },
};

export const Moving: Story = {
  render: (args) => <LiveLane args={args} selected={["ch-interview"]} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chapter = hit(canvas, /^Chapter Interview/);
    const box = chapter.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const x = box.left + 6;
    const user = userEvent.setup();
    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: chapter,
        coords: { clientX: x, clientY: y },
      },
      { target: chapter, coords: { clientX: x + 30, clientY: y } },
      { target: chapter, coords: { clientX: x + 60, clientY: y } },
    ]);
    await expect(within(canvasElement).getByText("+10.00 s")).toBeVisible();
    await user.pointer({ keys: "[/MouseLeft]", target: chapter });
    await expect(args.onDragEnd).toHaveBeenCalledWith(
      "ch-interview",
      "move",
      true,
    );
    await expect(args.onSelect).not.toHaveBeenCalled();
  },
};

export const AddingChapter: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      adding={{ at: 12 }}
      window={{ start: 0, pxPerSecond: 6 }}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Chapter name" });
    await expect(field).toHaveFocus();
    await userEvent.keyboard("Q and A{Enter}");
    await expect(args.onAddCommit).toHaveBeenCalledWith(12, "Q and A");
    await expect(hit(canvas, /^Chapter Q and A/)).toBeVisible();
  },
};

export const DoubleClickToAdd: Story = {
  render: (args) => <LiveLane args={args} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const lane = canvas.getByRole("group", { name: "Markers" });
    const box = lane.getBoundingClientRect();
    const target = lane.querySelector(".sys-markers-track");
    if (!(target instanceof HTMLElement)) throw new Error("No track");
    await fireEvent.dblClick(target, {
      clientX: box.left + 60 * 6 - 10,
      clientY: box.top + 12,
    });
    await expect(args.onAdd).toHaveBeenCalledTimes(1);
    await expect(
      canvas.getByRole("textbox", { name: "Chapter name" }),
    ).toHaveFocus();
  },
};

const ISOLATED: readonly LaneMarker[] = [
  { kind: "comment", id: "iso-a", start: 10, author: "Maya" },
  { kind: "comment", id: "iso-b", start: 30, author: "Anneke" },
  { kind: "chapter", id: "iso-c", start: 45, title: "Outro" },
];

export const TouchTargets: Story = {
  render: (args) => <LiveLane args={args} markers={ISOLATED} touch withRuler />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(hit(canvas, /^Comment by Maya/)).toBeVisible();
    await expect(hit(canvas, /^Comment by Anneke/)).toBeVisible();
    await expect(hit(canvas, /^Chapter Outro/)).toBeVisible();
  },
};

export const ReadOnly: Story = {
  render: (args) => <LiveLane args={args} readOnly selected={["sc-joke"]} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("slider")).toBeNull();
    await userEvent.click(hit(canvas, /^Chapter Cold open/));
    await userEvent.unhover(hit(canvas, /^Chapter Cold open/));
    await expect(args.onSelect).toHaveBeenCalledWith("ch-open", false);
  },
};

export const Phone: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      markers={ALL_KINDS}
      selected={["sc-joke"]}
      window={{ start: 0, pxPerSecond: 6 }}
      touch
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector(".sys-markers")).toHaveAttribute(
      "data-touch",
      "true",
    );
    await expect(hit(canvas, /^Clip idea Best joke/)).toBeVisible();
  },
};

export const Wide: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      markers={WIDE}
      window={{ start: 0, pxPerSecond: 6 }}
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("group", { name: "Markers" }),
    ).toBeVisible();
  },
};

export const Nested: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      markers={NESTED}
      window={{ start: 0, pxPerSecond: 4 }}
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      hit(within(canvasElement), /^Clip idea Long clip/),
    ).toBeVisible();
  },
};

export const NestedZoomed: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      markers={NESTED}
      window={{ start: 95, pxPerSecond: 60 }}
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      hit(within(canvasElement), /^Chapter Inside chapter/),
    ).toBeVisible();
  },
};

export const FoldedOnRangeStart: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      markers={STACKED_START}
      selected={["s-clip"]}
      window={{ start: 0, pxPerSecond: 4 }}
      touch
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "1 more marker" }),
    ).toBeVisible();
  },
};

export const AddingChapterScrolledAway: Story = {
  render: (args) => (
    <LiveLane
      args={args}
      adding={{ at: 12 }}
      window={{ start: 100, pxPerSecond: 6 }}
      withRuler
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("textbox", { name: "Chapter name" }),
    ).toBeVisible();
  },
};
