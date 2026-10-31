import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { type InspectorSection, InspectorSheet } from "./InspectorSheet";
import type { SystemIconName } from "./icons";
import { AnchorMark, DemoDock, Framed } from "./inspectorSheetFixtures";
import type { InspectorDetent, InspectorRect } from "./inspectorSheetMath";
import {
  AUTO_REDUCTION_SECTIONS,
  CLIP_SECTIONS,
  COMMENT_SECTIONS,
  ENVELOPE_POINT_SECTIONS,
  LONG_SECTIONS,
  PENDING_SECTIONS,
  RANGE_SECTIONS,
  SEAM_SECTIONS,
  TRACK_SECTIONS,
  WORD_TIMING_SECTIONS,
} from "./inspectorSheetSections";

const meta: Meta<typeof InspectorSheet> = {
  title: "System/InspectorSheet",
  component: InspectorSheet,
  tags: ["autodocs"],
  args: { onClose: fn() },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Inspector sheet (design-system element 9a): the frame every object inspector shares. It takes plain data (an icon, a name, sections of rows) and renders the content as given, so the host owns the values; they apply as they change and there is no Apply button.\n\n**Card** (desktop and tablet). 320 px wide, placed in the box `bounds` by `anchor`: below the anchor when 60 % of the box fits there, otherwise above, otherwise on the side with more room and shortened to it. Its height stops at 60 % of the box and the body scrolls inside. The header is 40 px: the object icon, the name (an inline field when `onRename` is given; Enter or blur renames, Escape puts the name back) and Close. A titled section collapses by its heading, a button with `aria-expanded`. A row is a 12 px secondary label on the left and a control on the right; a row without a label gives the control the whole width. Escape closes unless a field inside took it. The host mounts the card in a positioned box.\n\n**Phone**. A bottom sheet with three detents: the 64 px dock (the host's action dock goes in `dock`), half (50 %) and full (92 %), as shares of the box it is mounted in. The grip is a 36 × 5 px bar with a 44 px hit area that reaches 36 px above the sheet and 8 px into it. Drag it up or down and the sheet follows the finger, then settles on the nearest detent (a flick carries it 120 ms further); let go more than 24 px below the dock, or flicked down from the dock, and `onDismiss` fires, which clears the selection (a flick down from half lands on the dock). Tapping the grip toggles half and dock (full steps down to half). The grip is a vertical slider for the keyboard: Up, Down, Right and Left step, Home and End go to the ends, Enter and Space toggle. Escape while dragging puts the sheet back. There are no Expand or Collapse buttons. At the dock detent the content is inert.\n\nThe demo bodies (Clip, Track, Range, Word timing, Seam) are built from `ScrubField`, `TimeField` and `AbAudition` in `inspectorSheetFixtures.tsx` and wire to nothing.\n\n**Motion.** The phone height settles with `--motion-panel`, and a section's chevron turns with `--motion-hover`. Reduced motion turns both off. The card does not animate.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof InspectorSheet>;

type CardProps = {
  icon: SystemIconName;
  name: string;
  sections: readonly InspectorSection[];
  anchorAt: (width: number, height: number) => InspectorRect;
  rename?: boolean;
};

function CardDemo({ icon, name, sections, anchorAt, rename }: CardProps) {
  const [label, setLabel] = useState(name);
  return (
    <Framed>
      {(bounds) => {
        const anchor = anchorAt(bounds.width, bounds.height);
        return (
          <>
            <AnchorMark anchor={anchor} />
            <InspectorSheet
              form="card"
              icon={icon}
              name={label}
              onRename={rename ? setLabel : undefined}
              sections={sections}
              anchor={anchor}
              bounds={bounds}
              onClose={fn()}
            />
          </>
        );
      }}
    </Framed>
  );
}

const nearTop = (width: number): InspectorRect => ({
  x: Math.round(width * 0.4),
  y: 72,
  width: 160,
  height: 40,
});

const nearBottom = (width: number, height: number): InspectorRect => ({
  x: Math.round(width * 0.4),
  y: height - 120,
  width: 160,
  height: 40,
});

export const DesktopCard: Story = {
  render: () => (
    <CardDemo
      icon="sliders-horizontal"
      name="Maya · 12:04 to 12:23"
      sections={CLIP_SECTIONS}
      anchorAt={nearTop}
      rename
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("dialog", { name: /Maya/ })).toBeVisible();
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Maya · 12:04 to 12:23",
    );
    await expect(canvas.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /apply/i })).toBeNull();
  },
};

export const TabletCard: Story = {
  render: () => (
    <CardDemo
      icon="volume-1"
      name="Maya"
      sections={TRACK_SECTIONS}
      anchorAt={nearBottom}
    />
  ),
};

export const LongContent: Story = {
  render: () => (
    <CardDemo
      icon="sliders-horizontal"
      name="Clip with every section"
      sections={LONG_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const timing = canvas.getByRole("button", { name: "Timing" });
    await expect(timing).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(timing);
    await expect(timing).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(timing);
    await expect(timing).toHaveAttribute("aria-expanded", "true");
  },
};

function ClosingDemo() {
  const [open, setOpen] = useState(true);
  return (
    <Framed>
      {(bounds) => {
        const anchor = nearTop(bounds.width);
        return open ? (
          <>
            <AnchorMark anchor={anchor} />
            <InspectorSheet
              form="card"
              icon="sliders-horizontal"
              name="Seam at 10:12.4"
              sections={SEAM_SECTIONS}
              anchor={anchor}
              bounds={bounds}
              onClose={() => setOpen(false)}
            />
          </>
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            Reopen inspector
          </button>
        );
      }}
    </Framed>
  );
}

export const Closing: Story = {
  render: () => <ClosingDemo />,
};

export const WordTiming: Story = {
  render: () => (
    <CardDemo
      icon="text-cursor-input"
      name="“really”"
      sections={WORD_TIMING_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", {
        name: "Word waveform, static demo",
      }),
    ).toBeVisible();
  },
};

export const Seam: Story = {
  render: () => (
    <CardDemo
      icon="scissors"
      name="Seam at 10:12.4"
      sections={SEAM_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("spinbutton", { name: "Offset" }),
    ).toHaveAttribute("aria-valuenow", "12");
    await expect(canvas.getByRole("button", { name: "A" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const EnvelopePoint: Story = {
  render: () => (
    <CardDemo
      icon="volume-1"
      name="Maya point 2"
      sections={ENVELOPE_POINT_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("spinbutton", { name: "Time" }),
    ).toHaveAttribute("aria-valuenow", "724.31");
    await expect(
      canvas.getByRole("spinbutton", { name: "Level" }),
    ).toHaveAttribute("aria-valuetext", "0.50 ×");
  },
};

export const AutoReduction: Story = {
  render: () => (
    <CardDemo
      icon="shield-check"
      name="Auto reduction"
      sections={AUTO_REDUCTION_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: /^Automatic reduction Timeline/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Restore original audio" }),
    ).toBeVisible();
  },
};

export const Comment: Story = {
  render: () => (
    <CardDemo
      icon="message-square"
      name="Comment"
      sections={COMMENT_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("textbox", { name: "Reply to comment" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Resolve" })).toBeVisible();
  },
};

export const Suggestion: Story = {
  render: () => (
    <CardDemo
      icon="scissors"
      name="Suggestion"
      sections={PENDING_SECTIONS}
      anchorAt={nearTop}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Reject" })).toBeVisible();
  },
};

export const Range: Story = {
  render: () => (
    <CardDemo
      icon="flag"
      name="Range"
      sections={RANGE_SECTIONS}
      anchorAt={nearTop}
    />
  ),
};

function PhoneDemo({
  initial,
  sections,
  name,
}: {
  initial: InspectorDetent;
  sections: readonly InspectorSection[];
  name: string;
}) {
  const [detent, setDetent] = useState(initial);
  const [open, setOpen] = useState(true);
  const [label, setLabel] = useState(name);
  return (
    <Framed>
      {() =>
        open ? (
          <InspectorSheet
            form="phone"
            icon="sliders-horizontal"
            name={label}
            onRename={setLabel}
            sections={sections}
            dock={<DemoDock />}
            detent={detent}
            onDetentChange={setDetent}
            onDismiss={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            Reopen inspector
          </button>
        )
      }
    </Framed>
  );
}

export const PhoneDock: Story = {
  render: () => (
    <PhoneDemo initial="dock" sections={CLIP_SECTIONS} name="Maya · 12:04" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Sheet height" }),
    ).toHaveAttribute("aria-valuetext", "Dock");
    await expect(
      canvasElement.querySelector(".sys-inspector-content"),
    ).toHaveAttribute("inert");
  },
};

export const PhoneHalf: Story = {
  render: () => (
    <PhoneDemo initial="half" sections={CLIP_SECTIONS} name="Maya · 12:04" />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Sheet height" }),
    ).toHaveAttribute("aria-valuetext", "Half height");
    await expect(canvas.getByRole("textbox", { name: "Name" })).toBeVisible();
  },
};

export const PhoneFull: Story = {
  render: () => (
    <PhoneDemo initial="full" sections={LONG_SECTIONS} name="Maya · 12:04" />
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("slider", { name: "Sheet height" }),
    ).toHaveAttribute("aria-valuetext", "Full height");
  },
};
