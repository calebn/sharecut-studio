import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import type { PreviewMode } from "../utils/playRange";
import {
  InspectorSeekFooterView,
  type InspectorSeekFooterViewProps,
} from "./index";

const meta: Meta<typeof InspectorSeekFooterView> = {
  title: "Templates/InspectorSeekFooter",
  component: InspectorSeekFooterView,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => (
      <div
        className="inspector modifier-inspector modifier-inspector--embedded"
        style={{ width: context.parameters.footerPhone ? "360px" : "22rem" }}
      >
        <div className="modifier-footer">
          <Story />
        </div>
      </div>
    ),
  ],
  args: { onSeek: fn(), onPlay: fn() },
};
export default meta;
type Story = StoryObj<typeof InspectorSeekFooterView>;

function PreviewModesPreview(args: InspectorSeekFooterViewProps) {
  const [mode, setMode] = useState<PreviewMode>(args.previewMode ?? "current");
  return (
    <InspectorSeekFooterView
      {...args}
      previewMode={mode}
      onPreviewModeChange={(next) => {
        setMode(next);
        args.onPreviewModeChange?.(next);
      }}
    />
  );
}

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Seek" }));
    await expect(args.onSeek).toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Play around" }));
    await expect(args.onPlay).toHaveBeenCalled();
  },
};

export const JoinButtons: Story = {
  args: {
    seekLabel: "Seek join",
    playLabel: "Play across join",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Seek join" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Play across join" }),
    ).toBeVisible();
  },
};

export const SeekOnly: Story = {
  args: { showPlay: false, seekLabel: "Seek to start" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Play around" }),
    ).toBeNull();
  },
};

export const PreviewModes: Story = {
  args: { previewMode: "suggested", onPreviewModeChange: fn() },
  render: (args) => <PreviewModesPreview {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Suggested" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: "A/B" }));
    await expect(args.onPreviewModeChange).toHaveBeenCalledWith("ab");
    await expect(canvas.getByRole("button", { name: "A/B" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

export const SkipUnavailable: Story = {
  args: {
    previewMode: "current",
    onPreviewModeChange: fn(),
    suggestDisabled: true,
    suggestDisabledReason:
      "A split does not change the mix until you delete a side.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Suggested" }),
    ).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "A/B" })).toBeDisabled();
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, footerPhone: true },
  globals: recordMobileViewport.globals,
  args: { previewMode: "suggested", onPreviewModeChange: fn() },
  render: (args) => <PreviewModesPreview {...args} />,
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".modifier-inspector"),
    ).toHaveStyle({ width: "360px" });
    await expect(
      within(canvasElement).getByRole("group", { name: "Preview mode" }),
    ).toBeVisible();
  },
};
