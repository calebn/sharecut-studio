import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Clip } from "./Clip";
import {
  Envelope,
  type EnvelopeChange,
  type EnvelopePointData,
} from "./Envelope";
import { dbToY, gainToDb } from "./envelopeMath";
import { Lane, LaneItem } from "./Lane";
import {
  ENVELOPE_POINTS,
  EPISODE_SECONDS,
  LANE_ROWS,
  stage,
} from "./laneFixtures";
import { Measured } from "./laneStoryHost";
import { VOICE_PEAKS } from "./prepareFixtures";
import { Ruler } from "./Ruler";

const PX_PER_SECOND = 24;
const noop = () => undefined;
const MAYA = LANE_ROWS[0] ?? { id: "", name: "", colorIndex: 0, clips: [] };

type StackProps = {
  points?: readonly EnvelopePointData[];
  selected?: string | null;
  visible?: boolean;
  readOnly?: boolean;
  touch?: boolean;
  height?: number;
  start?: number;
  pxPerSecond?: number;
  /** Set the host's hit attributes, as the wired lane does. */
  hits?: boolean;
};

/** What a host passes as `hitProps`: stable, so no point re-renders for it. */
const HIT_POINT = (
  id: string,
  time: number,
  db: number,
  selected: boolean,
) => ({
  "data-hit-kind": "envelope-point",
  "data-hit-id": id,
  "data-hit-detail": `${time.toFixed(2)} s ${db.toFixed(2)} dB`,
  "data-hit-selected": String(selected),
});
const HIT_PROPS = {
  point: HIT_POINT,
  line: { "data-hit-surface": "envelope", "data-hit-own-tap": "true" },
} as const;

/** One ruler and one lane of clips with the envelope over it, and the state a host would keep. */
function Stack({
  points = ENVELOPE_POINTS,
  selected = null,
  visible = true,
  readOnly,
  touch,
  height,
  start = 0,
  pxPerSecond = PX_PER_SECOND,
  hits = false,
}: StackProps) {
  const [list, setList] = useState(points);
  const [picked, setPicked] = useState(selected);
  const [clip, setClip] = useState<string | undefined>();
  const before = useRef<readonly EnvelopePointData[] | null>(null);
  const next = useRef(0);
  const change = (id: string, edit: EnvelopeChange) =>
    setList((now) =>
      now.map((point) =>
        point.id === id
          ? {
              ...point,
              time: edit.timeSeconds ?? point.time,
              db: edit.db ?? point.db,
            }
          : point,
      ),
    );
  return (
    <div style={stage}>
      <Measured>
        {(width) => (
          <div style={{ position: "relative", inlineSize: width }}>
            <Ruler
              start={start}
              pxPerSecond={pxPerSecond}
              width={width}
              duration={EPISODE_SECONDS}
              playhead={3}
              onSeek={noop}
            />
            <Lane
              name={MAYA.name}
              colorIndex={MAYA.colorIndex}
              height={height}
              start={start}
              pxPerSecond={pxPerSecond}
              width={width}
            >
              {MAYA.clips.map((item) => (
                <LaneItem key={item.id} at={item.at} duration={item.duration}>
                  <Clip
                    id={item.id}
                    name={item.name}
                    colorIndex={MAYA.colorIndex}
                    start={item.at}
                    duration={item.duration}
                    pxPerSecond={pxPerSecond}
                    peaks={VOICE_PEAKS}
                    selected={clip === item.id}
                    onSelect={setClip}
                  />
                </LaneItem>
              ))}
              <Envelope
                points={list}
                trackName={MAYA.name}
                colorIndex={MAYA.colorIndex}
                start={start}
                pxPerSecond={pxPerSecond}
                width={width}
                height={height}
                duration={EPISODE_SECONDS}
                selected={picked}
                visible={visible}
                readOnly={readOnly}
                touch={touch}
                hitProps={hits ? HIT_PROPS : undefined}
                onSelect={setPicked}
                onAdd={(timeSeconds, db) => {
                  next.current += 1;
                  const id = `added-${next.current}`;
                  setList((now) => [...now, { id, time: timeSeconds, db }]);
                  setPicked(id);
                }}
                onRemove={(id) => {
                  setList((now) => now.filter((point) => point.id !== id));
                  setPicked(null);
                }}
                onMove={change}
                onDragStart={() => {
                  before.current = list;
                  return true;
                }}
                onDragEnd={(_id, committed) => {
                  if (!committed && before.current) setList(before.current);
                  before.current = null;
                }}
              />
            </Lane>
          </div>
        )}
      </Measured>
    </div>
  );
}

const meta: Meta<typeof Stack> = {
  title: "System/Envelope",
  component: Stack,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The volume envelope over one track's lane (design-system element 15b, spec-edit OVL-ENVELOPE). A 2 px line in the track's colour runs through the points on a dB scale from -60 dB to +3.52 dB, the stored gain's ceiling of 1.5, so 0 dB sits about 7.5 px from the top of a 72 px lane, and a dashed guide marks it. Between two points the level is linear in gain, as the audio plays it, so on the dB scale a slope is a curve (halfway from 0 to -20 dB is -5.2 dB, not -10); the line is clipped to the window, so a host may pass every point. The level holds flat before the first point and after the last; with no points it is the unity line.\n\nA click on the line, not on a point, calls `onAdd(timeSeconds, db)`, the one callback without an id because the point is new. A point is dragged, with a readout chip (\"−3.0 dB · 12:04.3\") above it, between its neighbours and the episode and never closer than a millisecond to either; Escape, a blur or a lost pointer ends the drag uncommitted and the host puts the point back. A drag locks to the axis it first moves along and sends only that axis in `onMove(id, { timeSeconds?, db? })`, also when it is back at the start value; the other axis is never sent and an unchanged value is never rounded. A selected point has a ring; `onSelect(id)`, `onRemove(id)` and `onMove` carry the id first. The envelope speaks dB only: `envelopeMath` converts to the store's gain, a host stores `dbToGain(db)` for a changed level only and compares with `sameLevelDb` (`ENVELOPE_DB_STEP` is 0.01 dB).\n\nKeys are one tab stop (the selected point, else the first). On a focused point: Left and Right nudge 10 ms (Shift 100 ms), Up and Down 0.5 dB (Shift 5, Alt 0.05), Alt with Left or Right walks to the next point, Enter and Space select, Backspace and Delete remove a selected point. The point stops those keys, so the keymap never hears them. The envelope keeps no nudge state: the host folds every `onMove` into the `points` it passes back, so repeated presses add up, and closes the step at `onNudgeEnd`. Each point is a slider of its level whose value text includes the time. A read-only envelope (a guest) lets points be selected and read, and does nothing else; its plain arrow keys reach the keymap, while Alt with an arrow, Backspace, Delete, Enter and Space are still kept from it.\n\nOnly the strip along the line and the points take a pointer. Points have 16 px hit areas, 44 px on a coarse pointer (never more than half the gap to a neighbour); the line's strip is 12 px, 24 px coarse, so a clip under the overlay still takes its taps; a finger that starts on the strip pans the lane, a point does not. `hitProps` lets a host put `data-hit-*` attributes on each point and on the strip; without it the markup is unchanged. A host that wires this must treat Backspace as the envelope's while a point has focus: see the wiring prerequisite in element 15b.\n\n**Dragging** is a held drag set up by the story's play function; the real drag is tested in the browser. **Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Stack>;

export const Empty: Story = {
  args: { points: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("group", { name: "Volume envelope, Maya Okafor" }),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll(".sys-env-point")).toHaveLength(
      0,
    );
  },
};

export const Points: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("slider", { name: /^Envelope point/ }),
    ).toHaveLength(5);
    await expect(
      canvas.getByRole("slider", { name: "Envelope point 2" }),
    ).toHaveAttribute("aria-valuetext", "−6.0 dB at 0:04.00");
  },
};

export const Tall: Story = {
  args: { height: 240, selected: "env-3" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("slider", { name: /^Envelope point/ }),
    ).toHaveLength(5);
  },
};

export const PointSelected: Story = {
  args: { selected: "env-3" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Envelope point 3" }),
    ).toHaveAttribute("aria-current", "true");
  },
};

export const Dragging: Story = {
  args: { selected: "env-4", height: 104 },
  play: async ({ canvasElement }) => {
    const dot = canvasElement.querySelector<HTMLElement>('[data-id="env-4"]');
    if (!dot) throw new Error("no point to drag");
    const box = dot.getBoundingClientRect();
    const pointer = { pointerId: 7, pointerType: "mouse", button: 0 };
    const at = { clientX: box.left + box.width / 2, clientY: box.top + 10 };
    await fireEvent.pointerDown(dot, { ...pointer, ...at });
    await fireEvent.pointerMove(dot, {
      ...pointer,
      clientX: at.clientX + 24,
      clientY: at.clientY - 12,
    });
    await waitFor(() =>
      expect(canvasElement.querySelector(".sys-readout")).not.toBeNull(),
    );
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, selected: "env-2" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Envelope point 2" }),
    ).toHaveAttribute("aria-readonly", "true");
  },
};

export const Phone: Story = {
  args: { touch: true, height: 104, selected: "env-3" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".sys-env")).toHaveAttribute(
      "data-touch",
      "true",
    );
  },
};

/** Zero dB to the floor over 6 s, then a step up: the dashed 0 dB guide shows the gain curve against a straight dB join. */
const FADE: readonly EnvelopePointData[] = [
  { id: "fade-1", time: 2, db: 0 },
  { id: "fade-2", time: 8, db: -60 },
  { id: "fade-3", time: 12, db: -60 },
  { id: "fade-4", time: 12, db: -20 },
];

export const Fade: Story = {
  args: { points: FADE, selected: "fade-2" },
  play: async ({ canvasElement }) => {
    const line = canvasElement.querySelector(".sys-env-line");
    const d = line?.getAttribute("d") ?? "";
    const pieces = d
      .split(/(?=[ML])/)
      .map((piece) => piece.slice(1).split(" ").map(Number));
    const x = 5 * PX_PER_SECOND;
    let y = Number.NaN;
    for (let i = 1; i < pieces.length; i += 1) {
      const [x0 = 0, y0 = 0] = pieces[i - 1] ?? [];
      const [x1 = 0, y1 = 0] = pieces[i] ?? [];
      if (x >= x0 && x <= x1 && x1 > x0) {
        y = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    // Halfway through a 0 dB to -60 dB fade the gain is 0.5: -6 dB, not -30.
    await expect(Math.abs(y - dbToY(gainToDb(0.5), 72))).toBeLessThan(1);
  },
};

/** The state a host keeps: nudges fed back into `points` add up, and `hitProps` is set. */
export const Wired: Story = {
  args: { selected: "env-2", hits: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dot = canvas.getByRole("slider", { name: "Envelope point 2" });
    await expect(dot).toHaveAttribute("data-hit-kind", "envelope-point");
    await expect(dot).toHaveAttribute("data-hit-selected", "true");
    await expect(canvasElement.querySelector(".sys-env-band")).toHaveAttribute(
      "data-hit-own-tap",
      "true",
    );
    dot.focus();
    await userEvent.keyboard(
      "{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}",
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("slider", { name: "Envelope point 2" }),
      ).toHaveAttribute("aria-valuetext", "−6.0 dB at 0:04.30"),
    );
  },
};
