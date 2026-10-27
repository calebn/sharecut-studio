import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Clip, type ClipGrip, type ClipProps } from "./Clip";
import { VOICE_PEAKS } from "./prepareFixtures";
import { ReadoutChip } from "./ReadoutChip";

const PX_PER_SECOND = 40;

const meta: Meta<typeof Clip> = {
  title: "System/Clip",
  component: Clip,
  tags: ["autodocs"],
  args: {
    id: "clip-take-2",
    name: "Maya, take 2",
    colorIndex: 1,
    start: 4,
    duration: 4,
    pxPerSecond: PX_PER_SECOND,
    fadeIn: 200,
    fadeOut: 400,
    room: { before: 1, after: 2 },
    peaks: VOICE_PEAKS,
    onSelect: fn(),
    onDragStart: fn(),
    onDrag: fn(),
    onDragEnd: fn(),
    onNudge: fn(),
    onNudgeEnd: fn(),
    onLaneStep: fn(),
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A clip on a lane (design-system element 17): a 6 px rounded block in the track's colour with its peaks. The label shows only when the clip is wider than 80 px, and the clip is always named for assistive tech. On hover the 8 px trim zones at both edges show a resize cursor and the 10 px fade knobs appear at the top corners. Selected, the clip gets a 2 px accent outline, the trim handles become 6 × 24 tabs and the knobs stay. Fades draw as a curve in the top corners with the faded area at 40 % of the clip's ink. A muted region is a grey diagonal hatch with a speaker-off glyph at its foot. Under a coarse pointer the handles' hit areas grow to 44 px, always inside the clip: the trim zones at the edges and a fade knob on each side of the middle. An unselected clip's edges stay part of the body, so a touch there selects, and a swipe that starts on an unselected clip pans the lane. A selected clip's body moves under one finger.\n\nThe clip is a view. Every callback takes the clip's `id` first. A press on the body or a handle reports `onDragStart` (return `false` to refuse it), `onDrag` (client x and y, pixels from the press, Shift and Alt) and `onDragEnd`, and the host turns pixels into time and the pointer into a lane. Escape, a window blur, the browser or leaving the page ends a drag as not committed. The clip body is one tab stop. Once it is selected, Alt with Left or Right walks focus along its four handles, which are sliders with the edge time or fade length. Left or Right on a handle nudges the edge 10 ms (Shift 100 ms) with `onNudge` and `onNudgeEnd` closes the undo step. Up and Down report `onLaneStep`. A guest sees no handles and cannot drag. `ghost` draws the clip as a move's destination. Seams between clips and the readout chip are drawn by the lane, not here.\n\n**Motion.** None. Handles and knobs appear without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Clip>;

const lane: CSSProperties = {
  position: "relative",
  boxSizing: "content-box",
  blockSize: "4.5rem",
  margin: "var(--space-5)",
  padding: "var(--space-3) 0",
  background: "var(--color-bg-sunken)",
  borderRadius: "var(--radius-md)",
};

const inLane = (width: number): CSSProperties => ({
  position: "absolute",
  insetBlock: "var(--space-3)",
  insetInlineStart: "var(--space-5)",
  inlineSize: width,
});

function Lane({ children }: { children: ReactNode }) {
  return <div style={lane}>{children}</div>;
}

const widthOf = (args: ClipProps) => args.duration * args.pxPerSecond;

const slider = (canvas: ReturnType<typeof within>, name: RegExp) =>
  canvas.getByRole("slider", { name });

type Shape = Required<
  Pick<ClipProps, "start" | "duration" | "fadeIn" | "fadeOut">
>;

function applyGrip(shape: Shape, grip: ClipGrip, seconds: number): Shape {
  const ms = seconds * 1000;
  const longest = (duration: number) => duration * 1000;
  switch (grip) {
    case "move":
      return { ...shape, start: shape.start + seconds };
    case "trim-in":
      return {
        ...shape,
        start: shape.start + seconds,
        duration: Math.max(0.2, shape.duration - seconds),
      };
    case "trim-out":
      return { ...shape, duration: Math.max(0.2, shape.duration + seconds) };
    case "fade-in":
      return {
        ...shape,
        fadeIn: Math.min(
          longest(shape.duration),
          Math.max(0, shape.fadeIn + ms),
        ),
      };
    case "fade-out":
      return {
        ...shape,
        fadeOut: Math.min(
          longest(shape.duration),
          Math.max(0, shape.fadeOut - ms),
        ),
      };
  }
}

function LiveClip(args: ClipProps) {
  const [shape, setShape] = useState<Shape>({
    start: args.start,
    duration: args.duration,
    fadeIn: args.fadeIn ?? 0,
    fadeOut: args.fadeOut ?? 0,
  });
  const [selected, setSelected] = useState(args.selected ?? false);
  const [live, setLive] = useState<{ grip: ClipGrip; label: string } | null>(
    null,
  );
  const origin = useRef(shape);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const show = (grip: ClipGrip, next: Shape) => {
    const ms = Math.round(
      grip === "fade-in"
        ? next.fadeIn
        : grip === "fade-out"
          ? next.fadeOut
          : (grip === "trim-out" ? next.duration : next.start) * 1000,
    );
    setLive({ grip, label: `${ms} ms` });
  };
  return (
    <>
      <Clip
        {...args}
        {...shape}
        selected={selected}
        dragging={live?.grip ?? null}
        onSelect={(id, modifiers) => {
          setSelected(true);
          args.onSelect(id, modifiers);
        }}
        onDragStart={(id, grip, pointer) => {
          origin.current = shapeRef.current;
          setSelected(true);
          return args.onDragStart?.(id, grip, pointer);
        }}
        onDrag={(id, grip, drag) => {
          const next = applyGrip(
            origin.current,
            grip,
            drag.dx / args.pxPerSecond / (drag.alt ? 10 : 1),
          );
          setShape(next);
          show(grip, next);
          args.onDrag?.(id, grip, drag);
        }}
        onDragEnd={(id, grip, committed) => {
          if (!committed) setShape(origin.current);
          setLive(null);
          args.onDragEnd?.(id, grip, committed);
        }}
        onNudge={(id, handle, ms, nudge) => {
          setShape((current) => applyGrip(current, handle, ms / 1000));
          args.onNudge?.(id, handle, ms, nudge);
        }}
      />
      {live ? (
        <div style={{ position: "absolute", insetBlockStart: "-1.75rem" }}>
          <ReadoutChip value={live.label} />
        </div>
      ) : null}
    </>
  );
}

const dragBy = async (handle: HTMLElement, dx: number) => {
  const box = handle.getBoundingClientRect();
  const y = box.top + box.height / 2;
  const x = box.left + box.width / 2;
  await userEvent.pointer([
    {
      keys: "[MouseLeft>]",
      target: handle,
      coords: { clientX: x, clientY: y },
    },
    { target: handle, coords: { clientX: x + dx / 2, clientY: y } },
    { target: handle, coords: { clientX: x + dx, clientY: y } },
    { keys: "[/MouseLeft]", target: handle },
  ]);
};

export const Idle: Story = {
  render: (args) => (
    <Lane>
      <div style={inLane(widthOf(args))}>
        <Clip {...args} />
      </div>
    </Lane>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: args.name }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.getByText(args.name)).toBeVisible();
    for (const handle of canvas.getAllByRole("slider")) {
      await expect(handle).toHaveAttribute("tabindex", "-1");
    }
  },
};

export const Hover: Story = {
  render: Idle.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole("button", { name: args.name }));
    await expect(slider(canvas, /^Fade out/)).toHaveAttribute(
      "aria-valuenow",
      "3600",
    );
  },
};

export const Selected: Story = {
  args: { selected: true },
  render: Idle.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: args.name }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getAllByRole("slider")).toHaveLength(4);
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: args.name })).toHaveFocus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await expect(slider(canvas, /^Trim start/)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(args.onNudge).toHaveBeenCalledWith(
      "clip-take-2",
      "trim-in",
      10,
      { repeat: false },
    );
  },
};

export const Trimming: Story = {
  args: { selected: true },
  render: (args) => (
    <Lane>
      <div style={inLane(widthOf(args) + 4 * PX_PER_SECOND)}>
        <LiveClip {...args} />
      </div>
    </Lane>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await dragBy(slider(canvas, /^Trim end/), PX_PER_SECOND);
    await expect(args.onDragStart).toHaveBeenCalledWith(
      "clip-take-2",
      "trim-out",
      expect.objectContaining({ shift: false, alt: false }),
    );
    await expect(args.onDragEnd).toHaveBeenCalledWith(
      "clip-take-2",
      "trim-out",
      true,
    );
    await expect(slider(canvas, /^Trim end/)).toHaveAttribute(
      "aria-valuenow",
      "9",
    );
  },
};

export const FadeDrag: Story = {
  args: { selected: true },
  render: Trimming.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await dragBy(slider(canvas, /^Fade out/), -PX_PER_SECOND / 2);
    await expect(args.onDragEnd).toHaveBeenCalledWith(
      "clip-take-2",
      "fade-out",
      true,
    );
    await expect(slider(canvas, /^Fade out/)).toHaveAttribute(
      "aria-valuenow",
      "3100",
    );
  },
};

export const Muted: Story = {
  args: { mutedRegions: [{ start: 1.25, end: 2.5 }] },
  render: Idle.render,
  play: async ({ canvasElement, args }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: args.name }),
    ).toHaveAccessibleDescription("Part of this clip is muted");
  },
};

export const Narrow: Story = {
  args: { duration: 1, name: "Maya, take 2" },
  render: Idle.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: args.name })).toBeVisible();
    await expect(canvas.queryByText(args.name)).toBeNull();
    await expect(canvas.getAllByRole("slider")).toHaveLength(2);
  },
};

export const LabelRule: Story = {
  render: (args) => (
    <>
      <Lane>
        <div style={inLane(80)}>
          <Clip {...args} name="Just under" duration={80 / PX_PER_SECOND} />
        </div>
      </Lane>
      <Lane>
        <div style={inLane(81)}>
          <Clip {...args} name="Just enough" duration={81 / PX_PER_SECOND} />
        </div>
      </Lane>
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Just under")).toBeNull();
    await expect(canvas.getByText("Just enough")).toBeVisible();
  },
};

export const Touch: Story = {
  args: { selected: true, touch: true, duration: 6 },
  render: Idle.render,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".sys-clip")).toHaveAttribute(
      "data-touch",
      "true",
    );
  },
};

function ButtedLane({ args }: { args: ClipProps }) {
  const [picked, setPicked] = useState("clip-b");
  const clips = [
    { id: "clip-a", name: "Maya, intro", start: 0, fadeIn: 0, fadeOut: 0 },
    { id: "clip-b", name: "Maya, take 2", start: 5, fadeIn: 0, fadeOut: 300 },
  ];
  return (
    <div style={{ maxInlineSize: "100%", overflowX: "auto" }}>
      <Lane>
        {clips.map((clip) => (
          <div
            key={clip.id}
            style={{
              position: "absolute",
              insetBlock: "var(--space-3)",
              insetInlineStart: `calc(var(--space-5) + ${clip.start * PX_PER_SECOND}px)`,
            }}
          >
            <Clip
              {...args}
              {...clip}
              duration={5}
              selected={picked === clip.id}
              onSelect={(id, modifiers) => {
                setPicked(id);
                args.onSelect(id, modifiers);
              }}
            />
          </div>
        ))}
      </Lane>
    </div>
  );
}

export const Butted: Story = {
  args: { touch: true },
  render: (args) => <ButtedLane args={args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Maya, take 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Maya, intro" }));
    await expect(
      canvas.getByRole("button", { name: "Maya, intro" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "Maya, take 2" }));
    await expect(
      canvas.getByRole("button", { name: "Maya, take 2" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, selected: true },
  render: Idle.render,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("slider")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: args.name }));
    await expect(args.onSelect).toHaveBeenCalledWith("clip-take-2", {
      shift: false,
      mod: false,
    });
  },
};
