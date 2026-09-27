import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import type { ToolMode } from "../state/types";
import { ToolModeToggleView } from "./ToolModeToggleView";
import { TransportFrame, TransportZone } from "./TransportFrame";

/**
 * Local-state preview: mirrors `setToolMode`'s comment-mode clear
 * (uiSlice.ts:475) so Select/Blade also drop Comment mode, and still calls
 * the story's `fn()` args so plays can assert on them.
 */
function ToolModePreview({
  compact,
  structuralToolsAllowed,
  selectTitle,
  bladeTitle,
  onSelect,
  onBlade,
  onToggleComment,
}: {
  compact?: boolean;
  structuralToolsAllowed: boolean;
  selectTitle: string;
  bladeTitle: string;
  onSelect: () => void;
  onBlade: () => void;
  onToggleComment: () => void;
}) {
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [commentMode, setCommentMode] = useState(false);
  return (
    <ToolModeToggleView
      compact={compact}
      structuralToolsAllowed={structuralToolsAllowed}
      toolMode={toolMode}
      commentMode={commentMode}
      selectTitle={selectTitle}
      bladeTitle={bladeTitle}
      onSelect={() => {
        setToolMode("select");
        setCommentMode(false);
        onSelect();
      }}
      onBlade={() => {
        setToolMode("blade");
        setCommentMode(false);
        onBlade();
      }}
      onToggleComment={() => {
        setCommentMode((value) => !value);
        onToggleComment();
      }}
    />
  );
}

const meta: Meta<typeof ToolModePreview> = {
  title: "Templates/ToolModeToggle",
  component: ToolModePreview,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    structuralToolsAllowed: true,
    selectTitle: "Select tool (V)",
    bladeTitle: "Blade tool (C)",
    onSelect: fn(),
    onBlade: fn(),
    onToggleComment: fn(),
  },
  decorators: [
    (Story, context) =>
      context.parameters.toolTogglePhone ? (
        <div className="daw-shell daw-shell--phone" style={{ width: 360 }}>
          <main aria-label="Stage">
            <Story />
          </main>
        </div>
      ) : (
        <div style={{ blockSize: "var(--transport-height)" }}>
          <TransportFrame>
            <TransportZone position="end">
              <div className="transport-primary-actions">
                <Story />
              </div>
            </TransportZone>
          </TransportFrame>
          <main aria-label="Stage" />
        </div>
      ),
  ],
};
export default meta;
type Story = StoryObj<typeof ToolModePreview>;

export const Select: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade" }));
    await userEvent.click(canvas.getByRole("button", { name: "Select" }));
    await expect(
      canvas.getByRole("button", { name: "Select" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(args.onSelect).toHaveBeenCalled();
  },
};

export const Blade: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade" }));
    await expect(canvas.getByRole("button", { name: "Blade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(args.onBlade).toHaveBeenCalled();
  },
};

export const CommentMode: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Comment" }));
    await expect(
      canvas.getByRole("button", { name: "Comment" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(args.onToggleComment).toHaveBeenCalled();
  },
};

export const CommentOnlyGuest: Story = {
  args: { structuralToolsAllowed: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Select" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Blade" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Comment" })).toBeTruthy();
  },
};

export const CompactPhone: Story = {
  args: { compact: true },
  parameters: { ...recordMobileViewport.parameters, toolTogglePhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Select" })).toBeTruthy();
    await expect(canvas.queryByRole("button", { name: "Comment" })).toBeNull();
  },
};
