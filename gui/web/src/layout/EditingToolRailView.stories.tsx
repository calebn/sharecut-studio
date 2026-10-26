import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ToolMode } from "../state/types";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggleView } from "./ToolModeToggleView";

function RailPreview({
  bladeAllowed,
  mayIngest,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onZoomIn,
  onZoomOut,
  onAddTrack,
  onImport,
  onCutAtPlayhead,
}: {
  bladeAllowed: boolean;
  mayIngest: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onAddTrack: () => void;
  onImport: () => void;
  onCutAtPlayhead: () => void;
}) {
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [commentMode, setCommentMode] = useState(false);
  return (
    <>
      <button
        type="button"
        className="ui-control--quiet"
        onClick={() => setCommentMode((v) => !v)}
      >
        Toggle comment mode
      </button>
      <EditingToolRailView
        bladeAllowed={bladeAllowed}
        mayIngest={mayIngest}
        toolMode={toolMode}
        commentMode={commentMode}
        toolToggle={
          <ToolModeToggleView
            compact
            bladeReason={
              bladeAllowed
                ? undefined
                : "Blade requires permission to suggest edits"
            }
            toolMode={toolMode}
            commentMode={commentMode}
            selectTitle="Select tool (V)"
            bladeTitle="Blade tool (C)"
            commentTitle="Toggle comment mode: tap or drag the ruler to set the comment time (⌘⇧C)"
            onSelect={() => {
              setToolMode("select");
              setCommentMode(false);
            }}
            onBlade={() => {
              setToolMode("blade");
              setCommentMode(false);
            }}
            onToggleComment={() => setCommentMode((v) => !v)}
          />
        }
        history={mayIngest ? { canUndo, canRedo } : null}
        onUndo={onUndo}
        onRedo={onRedo}
        zoom={{ canZoomIn: true, canZoomOut: true }}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onAddTrack={onAddTrack}
        onImport={onImport}
        onCutAtPlayhead={onCutAtPlayhead}
      />
    </>
  );
}

const meta: Meta<typeof RailPreview> = {
  title: "Templates/EditingToolRail",
  component: RailPreview,
  tags: ["autodocs"],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
  args: {
    bladeAllowed: true,
    mayIngest: true,
    canUndo: true,
    canRedo: false,
    onUndo: fn(),
    onRedo: fn(),
    onZoomIn: fn(),
    onZoomOut: fn(),
    onAddTrack: fn(),
    onImport: fn(),
    onCutAtPlayhead: fn(),
  },
  decorators: [
    (Story, context) => (
      <div
        className="daw-shell daw-shell--phone"
        style={{
          width: context.parameters.railTablet ? "48rem" : "360px",
          maxWidth: "100%",
        }}
      >
        <main className="mobile-mode-body">
          <div className="mobile-timeline-mode">
            <Story />
          </div>
        </main>
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RailPreview>;

export const SelectTool: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Select tool" }),
    ).toBeTruthy();
    await expect(
      canvas.queryByRole("button", { name: "Blade cut" }),
    ).toBeNull();
  },
};

export const UndoAndRedo: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await expect(args.onUndo).toHaveBeenCalled();
    const redo = canvas.getByRole("button", { name: "Redo" });
    await expect(redo).toHaveAttribute("aria-disabled", "true");
    await expect(redo).toHaveAccessibleDescription("Nothing to redo");
    await userEvent.click(redo);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Nothing to redo",
    );
    await expect(args.onRedo).not.toHaveBeenCalled();
  },
};

export const NothingToUndo: Story = {
  args: { canUndo: false, canRedo: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Undo" }),
    ).toHaveAccessibleDescription("Nothing to undo");
  },
};

export const BladeTool: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade tool" }));
    await userEvent.click(canvas.getByRole("button", { name: "Blade cut" }));
    await expect(args.onCutAtPlayhead).toHaveBeenCalled();
  },
};

export const CommentModeHidesCut: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade tool" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle comment mode" }),
    );
    await expect(
      canvas.queryByRole("button", { name: "Blade cut" }),
    ).toBeNull();
  },
};

export const IngestOnly: Story = {
  tags: ["wide-only"],
  args: { bladeAllowed: false },
  parameters: { railTablet: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Select tool" }),
    ).toBeNull();
    await expect(canvas.getByRole("button", { name: "+ Track" })).toBeTruthy();
    await expect(within(document.body).queryByRole("dialog")).toBeNull();
  },
};

export const Tablet: Story = {
  parameters: { railTablet: true },
};

export const PhoneWidth: Story = {};
