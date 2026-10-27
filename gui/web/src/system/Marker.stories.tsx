import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import { Marker, type MarkerProps } from "./Marker";

const noop = () => undefined;

const meta: Meta<typeof Marker> = {
  title: "System/Marker",
  component: Marker,
  tags: ["autodocs"],
  args: {
    kind: "chapter",
    title: "Cold open",
    time: "0:00",
    at: 0.05,
    onSelect: noop,
  },
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "One glyph family for the 24 px marker lane (design-system element 18). A **chapter** is a flag in the chapter token with its title inline, cut off where the next marker starts. A **comment** is a 16 px speech-bubble pin with the author's initial, and a range comment adds a 3 px bar to its end. A **clip idea** is a bracket pair joined by a 2 px line in the social token, hatched while proposed and solid once approved. Markers that overlap fold into a **+N** chip that opens the list. A marker sits at a fraction of the lane, so the lane that hosts it (a positioned parent) owns the time scale. Hover or focus shows the title and time; selecting draws the 2 px accent outline, and the Action bar carries the verbs. Under a coarse pointer each marker's hit area grows to 44 px.\n\n**Motion.** None. Selection and the tip appear without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Marker>;

const lane: CSSProperties = {
  position: "relative",
  blockSize: "1.5rem",
  border: "1px solid var(--color-border-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-bg-raised)",
};

function Lane({ markers }: { markers: readonly MarkerProps[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div style={{ padding: "var(--space-5)" }}>
      <div style={lane}>
        {markers.map((marker, index) => (
          <Marker
            key={`${marker.kind}-${marker.at}`}
            {...marker}
            selected={selected === index}
            onSelect={() => setSelected(index)}
          />
        ))}
      </div>
    </div>
  );
}

const all = [
  {
    kind: "chapter",
    title: "Cold open",
    time: "0:00",
    at: 0.02,
    to: 0.22,
    onSelect: noop,
  },
  {
    kind: "chapter",
    title: "The long way round",
    time: "12:30",
    at: 0.24,
    to: 0.4,
    onSelect: noop,
  },
  { kind: "comment", author: "Maya", time: "22:50", at: 0.44, onSelect: noop },
  {
    kind: "comment",
    author: "Jonas",
    time: "20:02",
    at: 0.5,
    to: 0.62,
    onSelect: noop,
  },
  {
    kind: "clip",
    title: "Origin story",
    time: "30:00",
    at: 0.66,
    to: 0.78,
    proposed: true,
    onSelect: noop,
  },
  {
    kind: "clip",
    title: "Best advice",
    time: "38:12",
    at: 0.8,
    to: 0.9,
    proposed: false,
    onSelect: noop,
  },
  { kind: "stack", count: 3, at: 0.93, onSelect: noop },
] satisfies MarkerProps[];

export const AllKinds: Story = {
  render: () => <Lane markers={all} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Chapter Cold open, 0:00" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Comment by Maya, 22:50" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "3 more markers" }),
    ).toBeVisible();
  },
};

export const Selected: Story = {
  render: () => <Lane markers={all} />,
  play: async ({ canvasElement }) => {
    const flag = within(canvasElement).getByRole("button", {
      name: "Chapter The long way round, 12:30",
    });
    await userEvent.click(flag);
    await expect(flag).toHaveAttribute("aria-pressed", "true");
  },
};

export const ProposedAndApproved: Story = {
  render: () => (
    <Lane markers={all.filter((marker) => marker.kind === "clip")} />
  ),
};

export const Hover: Story = {
  render: () => <Lane markers={all} />,
  play: async ({ canvasElement }) => {
    await userEvent.hover(
      within(canvasElement).getByRole("button", {
        name: "Chapter Cold open, 0:00",
      }),
    );
    await expect(within(document.body).getByRole("tooltip")).toHaveTextContent(
      "Cold open0:00",
    );
  },
};

const dense = Array.from({ length: 12 }, (_, index): MarkerProps => {
  const at = 0.04 + index * 0.012;
  return index % 2 === 0
    ? {
        kind: "comment",
        author: "Maya",
        time: `${index}:00`,
        at,
        onSelect: noop,
      }
    : {
        kind: "chapter",
        title: `Chapter ${index}`,
        time: `${index}:30`,
        at,
        to: at + 0.012,
        onSelect: noop,
      };
});

export const Dense: Story = {
  render: () => (
    <Lane
      markers={[
        ...dense,
        { kind: "stack", count: 4, at: 0.34, onSelect: noop },
      ]}
    />
  ),
};

export const EmptyLane: Story = {
  render: () => <Lane markers={[]} />,
};

export const PhoneAllKinds: Story = {
  render: () => (
    <div style={{ inlineSize: "22.5rem" }}>
      <Lane markers={all} />
    </div>
  ),
};
