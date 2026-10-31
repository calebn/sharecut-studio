import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import {
  isolatedStoryParameters,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { ChooserDemo } from "./chooserStoryHost";
import type { ChooserTarget } from "./TargetChooser";

const CLIP: ChooserTarget = {
  id: "clip-1",
  kind: "clip",
  trackColorIndex: 0,
  label: "Maya take 2",
};
const SEAM: ChooserTarget = {
  id: "seam-1",
  kind: "seam",
  trackColorIndex: 0,
  label: "Cut at 12:04.3",
};
const COMMENT: ChooserTarget = {
  id: "comment-1",
  kind: "comment",
  trackColorIndex: 1,
  label: "Check the level here",
};
const SUGGESTION: ChooserTarget = {
  id: "suggestion-1",
  kind: "suggestion",
  trackColorIndex: 1,
  label: "Remove 3 filler words",
};
const POINT: ChooserTarget = {
  id: "point-1",
  kind: "envelope-point",
  trackColorIndex: 2,
  label: "-3.0 dB at 12:04.3",
};
const WORD: ChooserTarget = {
  id: "word-1",
  kind: "word",
  trackColorIndex: 2,
  label:
    "“welcome to the show, and thank you for joining us on this long and winding episode”",
};

const meta: Meta<typeof ChooserDemo> = {
  title: "Stages/Edit/TargetChooser",
  component: ChooserDemo,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The touch target chooser (spec-edit POP-CHOOSER): on a long-press over overlapping targets, a fan of 44 px round chips opens 56 px above the finger (to the chip's centre). Each chip carries its object kind's icon (clip, seam, comment, suggestion, envelope point, word) in a 3 px ring of its track's colour. Slide to a chip and lift to select it; lift anywhere else to cancel. It is never drawn for one target: under two it renders nothing.\n\nThe leaf is plain data: `targets` ({ id, kind, trackColorIndex, label }), `anchor`, `bounds`, `over` (a target id), `onPick(id)` and `onCancel()`. It reads no store and runs no command, and it owns no gesture: the host holds the press, reports the chip under the finger as `over` (each chip carries `data-target-id`), calls `onPick` on a lift over a chip and `onCancel` on a lift elsewhere. At most five chips are drawn, in the order given (left to right); a longer list is paged by the host. The caption, on the far side of the arc from the press point, is the label of the chip `over` names.\n\nThe fan is positioned inside the box it is mounted in, never over the press point: the outer chips' lower edge is 28 px above it (a sag of 6 px, 8 px clear of an assumed 20 px fingertip), 16 px from the box's edges, and it opens below the point near the top. There is no portal, top layer or fixed position here; the host adds those.\n\nThis story host is a fixture: press and hold the surface for half a second to open the fan there, slide over a chip and lift. Its grammar is a stub; the app's hit router owns the real gesture.\n\n**Keys.** Left, Right, Home and End move between chips and Escape cancels (`useMenuKeyboard`, the only window listener); while the fan is open the keymap holds every key, so Escape does not also clear the selection. Enter and Space pick the focused chip. Tab out of the fan cancels it. Chips are `role=\"menuitem\"` buttons named \"Clip, Maya take 2\". The host announces \"3 targets here\". Opening the fan focuses its first chip, as the Create here menu does.",
      },
    },
  },
  args: { targets: [CLIP, COMMENT], at: { x: 240, y: 256 } },
};

export default meta;
type Story = StoryObj<typeof ChooserDemo>;

export const TwoTargets: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = await canvas.findByRole("menu", { name: "Targets here, 2" });
    await expect(menu).toBeVisible();
    await expect(
      canvas
        .getAllByRole("menuitem")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Clip, Maya take 2", "Comment, Check the level here"]);
  },
};

export const FourTargets: Story = {
  args: {
    targets: [CLIP, SEAM, COMMENT, SUGGESTION],
    over: "seam-1",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("menu")).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(4);
    await expect(canvas.getByText("Cut at 12:04.3")).toBeInTheDocument();
  },
};

export const NearEdge: Story = {
  args: { targets: [CLIP, SEAM, COMMENT, SUGGESTION], at: { x: 24, y: 256 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The jsdom run has no layout; the clamp inside the 16 px gutter is
    // measured in e2e-storybook/edit-popovers.spec.ts.
    await expect(await canvas.findByRole("menu")).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(4);
  },
};

export const NearTop: Story = {
  args: { targets: [CLIP, COMMENT, POINT], at: { x: 240, y: 40 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = await canvas.findByRole("menu");
    await expect(menu).toHaveAttribute("data-placement", "below");
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(3);
  },
};

export const Phone: Story = {
  parameters: isolatedStoryParameters,
  args: {
    targets: [CLIP, SEAM, COMMENT, POINT, WORD],
    at: { x: 160, y: 256 },
    over: "word-1",
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("menu")).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(5);
  },
};

export const PhoneEdge: Story = {
  parameters: isolatedStoryParameters,
  args: {
    targets: [CLIP, SEAM, COMMENT, POINT, WORD],
    at: { x: 6, y: 256 },
  },
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const canvas = within(canvasElement);
    // The 16 px gutter is measured in e2e-storybook/edit-popovers.spec.ts.
    await expect(await canvas.findByRole("menu")).toBeVisible();
    await expect(canvas.getAllByRole("menuitem")).toHaveLength(5);
  },
};

export const Gesture: Story = {
  args: {
    targets: [CLIP, SEAM, COMMENT, SUGGESTION],
    at: { x: 240, y: 256 },
    initialOpen: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("menu")).toBeNull();
    await expect(
      await canvas.findByRole("button", { name: "Open the chooser again" }),
    ).toBeVisible();
  },
};
