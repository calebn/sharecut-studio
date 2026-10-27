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
    startAt: 13,
    endAt: 15,
    count: 54,
    startText: "before small",
    endText: "after can",
    onDrag: fn(),
    onStep: fn(),
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
          "The two grips at the ends of a run of words (design-system element 13): a 2 px accent caret with a 12 px knob, the start's above the line and the end's below it. Drag an end to extend or shrink by word. Each grip is a slider over the places the keyboard stops: Right and Up move the edge one place on, Left and Down one back, Home and End to the first and last place. So the start grip shrinks the run when it moves on and the end grip grows it. Under a coarse pointer each grip is 44 px wide and reaches 14 px above and below its line, and a touch moves the caret, not the finger, so a thumb under the line still points at it.\n\nThe grips are not tab stops. Shift with the arrows and Alt+Shift with the arrows do the same from the words, which are already one tab stop. The pane places them at the ends of the selection and turns the point they report into a word (`dragEdge`).\n\n**Motion.** None.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SelectionHandles>;

export const Pair: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Selection start" }),
    ).toHaveAttribute("aria-valuetext", "before small");
    await expect(
      canvas.getByRole("slider", { name: "Selection end" }),
    ).toHaveAttribute("aria-valuetext", "after can");
  },
};

export const Stepping: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("slider", { name: "Selection end" }).focus();
    await userEvent.keyboard("{ArrowRight}{Home}");
    await expect(args.onStep).toHaveBeenNthCalledWith(1, "end", 1);
    await expect(args.onStep).toHaveBeenNthCalledWith(2, "end", "first");
  },
};
