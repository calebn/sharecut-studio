import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { Seam, type SeamProps } from "./Seam";

const noop = () => undefined;

const meta: Meta<typeof Seam> = {
  title: "System/Seam",
  component: Seam,
  tags: ["autodocs"],
  args: {
    form: "diamond",
    kind: "cut",
    label: "Cut at 12:04.3",
    detail: "2.4 s removed",
    onSelect: noop,
  },
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The one mark for a boundary between two pieces of audio (design-system element 20). On the timeline it is a 6 px diamond on the lane's top edge: filled for a cut, hollow for a split. In the Script it is an 18 px pill with the scissors and the removed length. Hovering or focusing it shows a tip: the label and detail for a diamond, the cut words for a pill. Escape closes the tip, a touch never opens one, and the accessible name carries the same facts. Selecting it (click, Enter or Space) draws the 2 px accent outline. Its verbs (Hear across, Keep, join type, Comment, Inspect) belong to the Action bar, not to the mark. Under a coarse pointer the diamond's hit area is 44 px square and the pill's grows to 44 px tall without moving the text around it.\n\n**Motion.** None. The tip appears with hover and the diamond grows a little under the pointer without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Seam>;

const lane: CSSProperties = {
  position: "relative",
  blockSize: "4.5rem",
  border: "1px solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-raised)",
};

const at = (fraction: number): CSSProperties => ({
  position: "absolute",
  insetBlockStart: 0,
  insetInlineStart: `${fraction * 100}%`,
  translate: "-50% -50%",
});

function Lane({
  marks,
}: {
  marks: readonly { at: number; seam: SeamProps }[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div
      style={{ padding: "var(--space-5)", paddingBlockStart: "var(--space-7)" }}
    >
      <div style={lane}>
        {marks.map((mark, index) => (
          <span key={mark.at} style={at(mark.at)}>
            <Seam
              {...mark.seam}
              selected={selected === index}
              onSelect={() => setSelected(index)}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

const kinds = [
  {
    at: 0.2,
    seam: {
      form: "diamond",
      kind: "cut",
      label: "Cut at 4:10.2",
      detail: "2.4 s removed",
      onSelect: noop,
    },
  },
  {
    at: 0.5,
    seam: {
      form: "diamond",
      kind: "split",
      label: "Split at 12:04.3",
      detail: "Two clips meet here",
      onSelect: noop,
    },
  },
  {
    at: 0.8,
    seam: {
      form: "diamond",
      kind: "cut",
      label: "Cut at 26:30.0",
      detail: "0.6 s removed",
      onSelect: noop,
    },
  },
] satisfies { at: number; seam: SeamProps }[];

export const SeamKinds: Story = {
  render: () => <Lane marks={kinds} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Cut at 4:10.2" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Split at 12:04.3" }),
    ).toBeVisible();
  },
};

export const Selected: Story = {
  render: () => <Lane marks={kinds} />,
  play: async ({ canvasElement }) => {
    const split = within(canvasElement).getByRole("button", {
      name: "Split at 12:04.3",
    });
    await userEvent.click(split);
    await expect(split).toHaveAttribute("aria-pressed", "true");
  },
};

export const Hover: Story = {
  render: () => <Lane marks={kinds} />,
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", { name: "Cut at 4:10.2" }),
    );
    await expect(within(document.body).getByRole("tooltip")).toHaveTextContent(
      "2.4 s removed",
    );
  },
};

const dense = Array.from({ length: 28 }, (_, index) => ({
  at: 0.03 + index * 0.034,
  seam: {
    form: "diamond",
    kind: index % 3 === 1 ? "split" : "cut",
    label: `${index % 3 === 1 ? "Split" : "Cut"} ${index + 1}`,
    onSelect: noop,
  },
})) satisfies { at: number; seam: SeamProps }[];

export const Dense: Story = {
  render: () => <Lane marks={dense} />,
};

export const PhoneDense: Story = {
  render: () => (
    <div style={{ inlineSize: "22.5rem" }}>
      <Lane marks={dense.slice(0, 14)} />
    </div>
  ),
};

const copy: CSSProperties = {
  maxInlineSize: "30rem",
  padding: "var(--space-5)",
  fontSize: "var(--font-size-body)",
  lineHeight: 1.7,
};

const pill = {
  form: "pill",
  removed: "2.4 s",
  words: "so, um, you know what I mean",
  onSelect: noop,
} satisfies SeamProps;

function Paragraph(props: { selected?: boolean }) {
  return (
    <p style={copy}>
      The first season was mostly about getting the room right,{" "}
      <Seam {...pill} selected={props.selected} /> and then we found the
      microphones that made the voices sit properly.
    </p>
  );
}

export const TextPill: Story = {
  render: () => <Paragraph />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Cut, 2.4 s removed" }),
    ).toBeVisible();
  },
};

export const TextPillHover: Story = {
  render: () => <Paragraph />,
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole("button"));
    await expect(within(document.body).getByRole("tooltip")).toHaveTextContent(
      "so, um, you know what I mean",
    );
  },
};

export const TextPillSelected: Story = {
  render: () => <Paragraph selected />,
};

export const PhoneTextPill: Story = {
  render: () => (
    <div style={{ inlineSize: "22.5rem" }}>
      <Paragraph />
    </div>
  ),
};

export const AllKinds: Story = {
  render: () => (
    <>
      <Lane marks={kinds} />
      <Paragraph />
    </>
  ),
};
