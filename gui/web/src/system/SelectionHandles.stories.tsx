import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { SelectionHandles } from "./SelectionHandles";

const meta: Meta<typeof SelectionHandles> = {
  title: "System/SelectionHandles",
  component: SelectionHandles,
  tags: ["autodocs"],
  args: {
    start: { x: 112, y: 36, height: 20 },
    end: { x: 262, y: 36, height: 20 },
    onDrag: fn(),
    onGrab: fn(),
    onRelease: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          maxInlineSize: "22rem",
          blockSize: "8rem",
          margin: "var(--space-5)",
          fontFamily: "var(--font-family-sans)",
          fontSize: "var(--font-size-review)",
          lineHeight: 1.625,
        }}
      >
        <p style={{ margin: 0, paddingBlockStart: "var(--space-4)" }}>
          a{" "}
          <mark
            style={{
              background: "var(--color-selection-subtle)",
              color: "inherit",
            }}
          >
            small room can
          </mark>{" "}
          sound like a large one.
        </p>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The two grips at the ends of a run of words (design-system element 13): a 2 px accent caret with a 12 px knob, the start's above the line and the end's below it. Drag an end to extend or shrink by word. A grip is pointer-only: it is hidden from assistive tech and is not a tab stop, because Shift with the arrows and Alt+Shift with the arrows do the same from the words, which are already one tab stop. The pane places the grips at the ends of the selection and turns the point they report into a word (`dragEdge`).\n\nA grip's hit region reaches only toward its knob, the start's above its line and the end's below, 14 px under a coarse pointer on top of the 44 px width. It covers no word on its own line. A press that never moves is passed to the button under the point, so a tap beside a grip still lands on the word. A touch moves the caret, not the finger, so a thumb under the line still points at it.\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SelectionHandles>;

export const Pair: Story = {
  play: async ({ canvasElement }) => {
    const grips = canvasElement.querySelectorAll(".sys-handle");
    await expect(grips).toHaveLength(2);
    for (const grip of grips) {
      await expect(grip).toHaveAttribute("aria-hidden", "true");
      await expect(grip).not.toHaveAttribute("tabindex");
    }
    await expect(within(canvasElement).queryByRole("slider")).toBeNull();
  },
};

export const Dragging: Story = {
  play: async ({ canvasElement, args }) => {
    const knob = canvasElement.querySelector(
      ".sys-handle[data-edge='end'] .sys-handle-knob",
    );
    if (!(knob instanceof HTMLElement)) throw new Error("No end knob");
    const r = knob.getBoundingClientRect();
    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: knob },
      { coords: { x: r.left + 30, y: r.top + 30 } },
      { keys: "[/MouseLeft]" },
    ]);
    await expect(args.onGrab).toHaveBeenCalledTimes(1);
    await expect(args.onDrag).toHaveBeenCalled();
    await expect(args.onRelease).toHaveBeenCalledTimes(1);
  },
};
