import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { clamp } from "../utils/math";
import { ALL_KINDS, EPISODE_SECONDS, stage } from "./laneFixtures";
import { LanesBelow, Measured } from "./laneStoryHost";
import { MarkerLane } from "./MarkerLane";
import {
  RULER_MIN_SELECTION,
  Ruler,
  type RulerEdge,
  type RulerProps,
  type RulerSession,
} from "./Ruler";
import type { TimeRange } from "./seconds";

const meta: Meta<typeof Ruler> = {
  title: "System/Ruler",
  component: Ruler,
  tags: ["autodocs"],
  args: {
    start: 0,
    pxPerSecond: 1,
    width: 360,
    duration: EPISODE_SECONDS,
    playhead: 0,
    onSeek: fn(),
    onFit: fn(),
    onScrubStart: fn(),
    onScrub: fn(),
    onScrubEnd: fn(),
    onSelectionDragStart: fn(),
    onSelectionDrag: fn(),
    onSelectionDragEnd: fn(),
    onSelectionNudge: fn(),
    onSelectionNudgeEnd: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The time ruler (design-system element 17a), 24 px tall. It takes plain data: the window's `start` and `pxPerSecond`, its `width`, the `playhead`, and optionally the selection and the recording sessions. Labels are Plex Mono 11 px at the smallest nice interval that keeps them 4 rem apart, so zooming picks a coarser or finer step by itself. The playhead is a 2 px accent line with a 10 px triangle; a host that draws the needle itself, such as the phone's fixed line or a moving one that must not re-render the ruler, sets `hidePlayhead`, and the slider value and keys still follow `playhead`. A selection is a 4 px accent band along the bottom with a 12 px knob at each end.\n\nA click seeks (`onSeek`). A drag scrubs: `onScrubStart` (return `false` to refuse), `onScrub` with the pointer's time and `onScrubEnd`, which reports `committed: false` for Escape, a window blur, `pointercancel`, a lost capture or the ruler leaving the page, so the host puts the playhead back. A double-click fits (`onFit`). The knobs resize the selection with `onSelectionDragStart`, `onSelectionDrag` and `onSelectionDragEnd`. A guest gets no knobs.\n\nA finger only taps the ruler: a tap seeks (and a tap on a knob's 44 px area seeks too), and a swipe starting on the body never scrubs, because under a coarse pointer the body sets `touch-action: pan-x pan-y` and the browser pans the timeline instead. A mouse (and a pen on a fine-pointer screen) drags to scrub. Pinch and pan belong to the lanes host, and a second finger is ignored.\n\nThe ruler is one tab stop and a slider named for the playhead: Left and Right move it one tick (Shift ten) with `onSeek`, Home and End go to the ends. Alt with Left or Right walks focus to the selection knobs, which are sliders that Left and Right nudge by 10 ms (Shift 100 ms) with `onSelectionNudge` and `onSelectionNudgeEnd`.\n\n**Motion.** None. The playhead and the band move with no easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Ruler>;

type View = "fit" | { start: number; pxPerSecond: number };

type LiveProps = {
  args: RulerProps;
  view: View;
  playhead?: number;
  selection?: TimeRange;
  sessions?: readonly RulerSession[];
  touch?: boolean;
  readOnly?: boolean;
  below?: (
    width: number,
    start: number,
    pxPerSecond: number,
  ) => React.ReactNode;
};

const around = (value: number, range: TimeRange, edge: RulerEdge) =>
  edge === "start"
    ? clamp(value, 0, range.end - RULER_MIN_SELECTION)
    : clamp(value, range.start + RULER_MIN_SELECTION, EPISODE_SECONDS);

function LiveRuler({
  args,
  view,
  playhead: playheadAtStart = 0,
  selection: selectionAtStart,
  sessions,
  touch,
  readOnly,
  below,
}: LiveProps) {
  const [playhead, setPlayhead] = useState(playheadAtStart);
  const [selection, setSelection] = useState(selectionAtStart);
  const before = useRef<{ playhead: number; selection?: TimeRange }>({
    playhead,
    selection,
  });
  return (
    <div style={stage}>
      <Measured>
        {(width) => {
          const start = view === "fit" ? 0 : view.start;
          const pxPerSecond =
            view === "fit" ? width / EPISODE_SECONDS : view.pxPerSecond;
          return (
            <>
              <Ruler
                {...args}
                start={start}
                pxPerSecond={pxPerSecond}
                width={width}
                playhead={playhead}
                selection={selection}
                sessions={sessions}
                touch={touch}
                readOnly={readOnly}
                onSeek={(seconds) => {
                  setPlayhead(seconds);
                  args.onSeek(seconds);
                }}
                onScrubStart={(seconds, pointer) => {
                  before.current = { playhead, selection };
                  return args.onScrubStart?.(seconds, pointer);
                }}
                onScrub={(seconds, pointer) => {
                  setPlayhead(seconds);
                  args.onScrub?.(seconds, pointer);
                }}
                onScrubEnd={(committed) => {
                  if (!committed) setPlayhead(before.current.playhead);
                  args.onScrubEnd?.(committed);
                }}
                onSelectionDragStart={(edge, pointer) => {
                  before.current = { playhead, selection };
                  return args.onSelectionDragStart?.(edge, pointer);
                }}
                onSelectionDrag={(edge, drag) => {
                  setSelection((now) =>
                    now
                      ? { ...now, [edge]: around(drag.seconds, now, edge) }
                      : now,
                  );
                  args.onSelectionDrag?.(edge, drag);
                }}
                onSelectionDragEnd={(edge, committed) => {
                  if (!committed) setSelection(before.current.selection);
                  args.onSelectionDragEnd?.(edge, committed);
                }}
                onSelectionNudge={(edge, seconds, nudge) => {
                  setSelection((now) =>
                    now
                      ? {
                          ...now,
                          [edge]: around(now[edge] + seconds, now, edge),
                        }
                      : now,
                  );
                  args.onSelectionNudge?.(edge, seconds, nudge);
                }}
              />
              {below?.(width, start, pxPerSecond)}
            </>
          );
        }}
      </Measured>
    </div>
  );
}

const body = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("slider", { name: "Timeline position" });

const dragOn = async (target: HTMLElement, from: number, to: number) => {
  const box = target.getBoundingClientRect();
  const y = box.top + box.height / 2;
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target, coords: { clientX: from, clientY: y } },
    { target, coords: { clientX: (from + to) / 2, clientY: y } },
    { target, coords: { clientX: to, clientY: y } },
    { keys: "[/MouseLeft]", target },
  ]);
};

export const Fit: Story = {
  render: (args) => <LiveRuler args={args} view="fit" playhead={754} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(body(canvas)).toHaveAttribute("aria-valuemax", "3130");
    await expect(body(canvas)).toHaveAttribute("aria-valuenow", "754");
    await expect(canvas.getByText("0:00")).toBeVisible();
  },
};

export const Zoomed: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 604, pxPerSecond: 40 }}
      playhead={608.5}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("10:06")).toBeVisible();
    await expect(body(canvas)).toHaveAttribute("aria-valuetext", "10:08.5");
  },
};

export const EndTickRightAligned: Story = {
  args: { start: 0, pxPerSecond: 10, width: 300, duration: 30, playhead: 5 },
  render: (args) => (
    <div style={stage}>
      <div style={{ inlineSize: args.width }}>
        <Ruler {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const tick = canvasElement.querySelector<HTMLElement>(
      '.sys-ruler-tick[data-align="end"]',
    );
    const ruler = canvasElement.querySelector<HTMLElement>(".sys-ruler");
    await expect(tick).toHaveTextContent("0:30");
    await expect(
      Math.ceil(tick?.getBoundingClientRect().right ?? 0),
    ).toBeLessThanOrEqual(Math.ceil(ruler?.getBoundingClientRect().right ?? 0));
  },
};

/** A 320 px phone's ruler (256 px of time) fitted to a minute: "0:45" would touch the end label, so it gives way and "1:00" stays. */
export const NarrowEndLabel: Story = {
  args: {
    start: 0,
    pxPerSecond: 256 / 60,
    width: 256,
    duration: 60,
    playhead: 12,
  },
  render: (args) => (
    <div style={stage}>
      <div style={{ inlineSize: args.width }}>
        <Ruler {...args} />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const labelled = [
      ...canvasElement.querySelectorAll<HTMLElement>(".sys-ruler-tick"),
    ].filter((tick) => tick.textContent);
    await expect(labelled.map((tick) => tick.textContent)).toEqual([
      "0:00",
      "0:15",
      "0:30",
      "1:00",
    ]);
    const boxes = labelled.map((tick) => tick.getBoundingClientRect());
    for (let i = 1; i < boxes.length; i++) {
      await expect(boxes[i]?.left ?? 0).toBeGreaterThanOrEqual(
        boxes[i - 1]?.right ?? 0,
      );
    }
  },
};

export const WithSelection: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 604, pxPerSecond: 20 }}
      playhead={606}
      selection={{ start: 608, end: 614 }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Selection end" }),
    ).toHaveAttribute("aria-valuenow", "614");
    await expect(
      canvas.getByRole("slider", { name: "Selection start" }),
    ).toHaveAttribute("aria-valuetext", "10:08.000");
  },
};

export const ResizingSelection: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 604, pxPerSecond: 20 }}
      playhead={606}
      selection={{ start: 608, end: 614 }}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const end = canvas.getByRole("slider", { name: "Selection end" });
    await expect(end).toHaveAttribute("aria-valuenow", "614");
    await expect(
      canvas.getByRole("slider", { name: "Selection start" }),
    ).toHaveAttribute("aria-valuetext", "10:08.000");
    const box = end.getBoundingClientRect();
    await dragOn(end, box.left + box.width / 2, box.left + box.width / 2 + 40);
    await expect(args.onSelectionDragEnd).toHaveBeenCalledWith("end", true);
    await expect(end).toHaveAttribute("aria-valuenow", "616");
  },
};

function LoggedRuler({ args }: { args: RulerProps }) {
  const [events, setEvents] = useState<string[]>([]);
  const [drags, setDrags] = useState(0);
  return (
    <>
      <LiveRuler
        args={{
          ...args,
          onSelectionDragStart: (edge, pointer) => {
            setEvents((now) => [...now, `start ${edge}`]);
            return args.onSelectionDragStart?.(edge, pointer);
          },
          onSelectionDrag: (edge, drag) => {
            setDrags((now) => now + 1);
            args.onSelectionDrag?.(edge, drag);
          },
          onSelectionDragEnd: (edge, committed) => {
            setEvents((now) => [...now, `end ${edge} ${committed}`]);
            args.onSelectionDragEnd?.(edge, committed);
          },
        }}
        view={{ start: 604, pxPerSecond: 20 }}
        playhead={606}
        selection={{ start: 608, end: 614 }}
      />
      <output data-testid="events">{events.join(" | ")}</output>
      <output data-testid="drags">{drags}</output>
    </>
  );
}

export const LoggingSelectionDrag: Story = {
  render: (args) => <LoggedRuler args={args} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTestId("events"),
    ).toBeEmptyDOMElement();
  },
};

export const WithSessions: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view="fit"
      playhead={1900}
      sessions={[
        { start: 0, end: 1500, label: "S1" },
        { start: 1500, end: 2400, label: "S2" },
        { start: 2400, end: 3130, label: "S3" },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByText("S2")).not.toBeNull();
  },
};

export const Scrubbing: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 600, pxPerSecond: 12 }}
      playhead={605}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const ruler = body(canvas);
    const box = ruler.getBoundingClientRect();
    await dragOn(ruler, box.left + 60, box.left + 180);
    await expect(args.onScrubStart).toHaveBeenCalledTimes(1);
    await expect(args.onScrubEnd).toHaveBeenCalledWith(true);
    await expect(args.onSeek).not.toHaveBeenCalled();
    await expect(ruler).toHaveAttribute("aria-valuenow", "615");
  },
};

export const Keyboard: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 600, pxPerSecond: 12 }}
      playhead={605}
      selection={{ start: 608, end: 614 }}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(body(canvas)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(args.onSeek).toHaveBeenLastCalledWith(615);
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await expect(
      canvas.getByRole("slider", { name: "Selection start" }),
    ).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(args.onSelectionNudge).toHaveBeenLastCalledWith(
      "start",
      -0.01,
      { repeat: false },
    );
  },
};

export const ReadOnly: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 600, pxPerSecond: 12 }}
      playhead={605}
      selection={{ start: 608, end: 614 }}
      readOnly
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(body(canvas)).toBeVisible();
    await expect(
      canvas.queryByRole("slider", { name: "Selection start" }),
    ).toBeNull();
  },
};

export const AboveMarkers: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 0, pxPerSecond: 6 }}
      playhead={20}
      selection={{ start: 12, end: 36 }}
      below={(width, start, pxPerSecond) => (
        <>
          <MarkerLane
            markers={ALL_KINDS}
            start={start}
            pxPerSecond={pxPerSecond}
            width={width}
            duration={EPISODE_SECONDS}
            selected={["sc-joke"]}
            onSelect={fn()}
          />
          <LanesBelow width={width} />
        </>
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("group", { name: "Markers" }),
    ).toBeVisible();
  },
};

export const Phone: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 600, pxPerSecond: 24 }}
      playhead={607.5}
      selection={{ start: 605, end: 610 }}
      touch
      below={(width, start, pxPerSecond) => (
        <MarkerLane
          markers={[]}
          start={start}
          pxPerSecond={pxPerSecond}
          width={width}
          duration={EPISODE_SECONDS}
          touch
          onSelect={fn()}
        />
      )}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector(".sys-ruler")).toHaveAttribute(
      "data-touch",
      "true",
    );
    await expect(
      canvas.getByRole("slider", { name: "Selection end" }),
    ).toBeVisible();
  },
};

export const DeepZoom: Story = {
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 1799.9, pxPerSecond: 48_000 }}
      playhead={1799.95}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const labels = [...canvasElement.querySelectorAll(".sys-ruler-tick")]
      .map((tick) => tick.textContent ?? "")
      .filter(Boolean);
    await expect(labels.length).toBeGreaterThan(0);
    const drawnWidth =
      canvasElement.querySelector(".sys-ruler")?.getBoundingClientRect()
        .width ?? 0;
    await expect(labels.length).toBeLessThanOrEqual(Math.ceil(drawnWidth / 64));
    for (const label of labels)
      await expect(label).toMatch(/^\d+:\d{2}\.\d{3}$/);
    await expect(body(canvas)).toHaveAttribute("aria-valuetext", "29:59.950");
  },
};

export const HostDrawnNeedle: Story = {
  args: { hidePlayhead: true },
  render: (args) => (
    <LiveRuler
      args={args}
      view={{ start: 600, pxPerSecond: 24 }}
      playhead={607.5}
      touch
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelector(".sys-ruler-playhead")).toBeNull();
    await expect(body(canvas)).toHaveAttribute("aria-valuenow", "607.5");
    body(canvas).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(body(canvas)).not.toHaveAttribute("aria-valuenow", "607.5");
  },
};
