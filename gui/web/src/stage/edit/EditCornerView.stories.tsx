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
          "Fit, zoom out, zoom in, the eye (the View sheet) and the Script toggle, bottom-right of the lanes. On a phone it has no Script toggle and pinch stays.\n\n**Motion.** None; the eye's pressed state shows while its sheet is open.",
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
