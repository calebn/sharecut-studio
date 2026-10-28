import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { EditCornerView } from "./EditCornerView";

const meta: Meta<typeof EditCornerView> = {
  title: "Stages/Edit/Corner",
  component: EditCornerView,
  args: {
    zoom: { canZoomIn: true, canZoomOut: true },
    onZoomIn: fn(),
    onZoomOut: fn(),
    onFit: fn(),
    viewOpen: false,
    onToggleView: fn(),
    script: { shown: true, onToggle: fn() },
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", minBlockSize: "6rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Fit, zoom out, zoom in, the eye (the View sheet) and the Script toggle, bottom-right of the lanes. On a phone it has no Script toggle and pinch stays. On a touch screen (coarse pointer) it also holds the range bracket toggle: a finger cannot drag across empty lane, so arming the toggle makes the next drag draw a range. A mouse or pen drags a range directly and never shows it.\n\n**Motion.** None; the eye's and the range toggle's pressed state show while their mode is on.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof EditCornerView>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Zoom in" }));
    await expect(args.onZoomIn).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "View options" }));
    await expect(args.onToggleView).toHaveBeenCalledOnce();
  },
};

export const EyeSheetOpen: Story = {
  args: { viewOpen: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "View options" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const FullyZoomedIn: Story = {
  args: { zoom: { canZoomIn: false, canZoomOut: true } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Zoom in" }),
    ).toBeDisabled();
  },
};

export const Phone: Story = {
  args: { script: undefined },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("button", {
        name: "Show or hide Script",
      }),
    ).toBeNull();
  },
};

export const TouchWithRange: Story = {
  args: {
    script: undefined,
    range: { armed: false, onToggle: fn() },
  },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  play: async ({ args, canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", {
      name: "Select range",
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    await expect(args.range?.onToggle).toHaveBeenCalledOnce();
  },
};

export const RangeArmed: Story = {
  args: { range: { armed: true, onToggle: fn() } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Select range" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const RangeUnavailable: Story = {
  args: {
    range: {
      armed: false,
      reason: "Open a project to select a range",
      onToggle: fn(),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Select range" }),
    ).toBeDisabled();
  },
};
