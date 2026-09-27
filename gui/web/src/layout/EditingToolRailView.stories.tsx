import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ToolMode } from "../state/types";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggleView } from "./ToolModeToggleView";

function RailPreview({
  bladeAllowed,
  mayIngest,
  busy,
  error,
  trackIdsForCut,
  initialConfirmSec,
  onAddTrack,
  onImport,
  onCutAtPlayhead,
  onCancelCut,
  onConfirmCut,
}: {
  bladeAllowed: boolean;
  mayIngest: boolean;
  busy: boolean;
  error: string | null;
  trackIdsForCut: readonly string[];
  initialConfirmSec: number | null;
  onAddTrack: () => void;
  onImport: () => void;
  onCutAtPlayhead: () => void;
  onCancelCut: () => void;
  onConfirmCut: () => void;
}) {
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [commentMode, setCommentMode] = useState(false);
  const [confirmSec, setConfirmSec] = useState(initialConfirmSec);
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
        busy={busy}
        error={error}
        bladeConfirmSec={confirmSec}
        trackIdsForCut={trackIdsForCut}
        toolToggle={
          <ToolModeToggleView
            compact
            structuralToolsAllowed={bladeAllowed}
            toolMode={toolMode}
            commentMode={commentMode}
            selectTitle="Select tool (V)"
            bladeTitle="Blade tool (C)"
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
        onAddTrack={onAddTrack}
        onImport={onImport}
        onCutAtPlayhead={() => {
          setConfirmSec(12.5);
          onCutAtPlayhead();
        }}
        onCancelCut={() => {
          setConfirmSec(null);
          onCancelCut();
        }}
        onConfirmCut={() => {
          setConfirmSec(null);
          onConfirmCut();
        }}
      />
    </>
  );
}

const meta: Meta<typeof RailPreview> = {
  title: "Templates/EditingToolRail",
  component: RailPreview,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    bladeAllowed: true,
    mayIngest: true,
    busy: false,
    error: null,
    trackIdsForCut: ["host"],
    initialConfirmSec: null,
    onAddTrack: fn(),
    onImport: fn(),
    onCutAtPlayhead: fn(),
    onCancelCut: fn(),
    onConfirmCut: fn(),
  },
  decorators: [
    (Story, context) => (
      <div
        className="daw-shell daw-shell--phone"
        style={{
          width: context.parameters.railTablet ? "48rem" : "360px",
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
    await expect(canvas.getByRole("button", { name: "Select" })).toBeTruthy();
    await expect(
      canvas.queryByRole("button", { name: "Cut at playhead" }),
    ).toBeNull();
  },
};

export const BladeTool: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Cut at playhead" }),
    );
    await expect(
      within(document.body).getByRole("dialog", { name: "Confirm blade cut" }),
    ).toBeTruthy();
    await expect(args.onCutAtPlayhead).toHaveBeenCalled();
    await userEvent.click(
      within(document.body).getByRole("button", { name: "Cancel" }),
    );
    await expect(args.onCancelCut).toHaveBeenCalled();
  },
};

export const ConfirmCut: Story = {
  args: { initialConfirmSec: 12.5 },
  play: async ({ args }) => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Confirm blade cut",
    });
    await expect(dialog.textContent).toContain("host");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cut" }));
    await expect(args.onConfirmCut).toHaveBeenCalled();
  },
};

export const ConfirmAllDialogue: Story = {
  args: { initialConfirmSec: 12.5, trackIdsForCut: [] },
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Confirm blade cut",
    });
    await expect(dialog.textContent).toContain("all dialogue tracks");
  },
};

export const Cutting: Story = {
  args: { initialConfirmSec: 12.5, busy: true },
  play: async () => {
    const dialog = within(document.body).getByRole("dialog", {
      name: "Confirm blade cut",
    });
    await expect(
      within(dialog).getByRole("button", { name: "Cutting…" }),
    ).toBeDisabled();
  },
};

export const CommentModeHidesCut: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Blade" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle comment mode" }),
    );
    await expect(
      canvas.queryByRole("button", { name: "Cut at playhead" }),
    ).toBeNull();
  },
};

export const IngestOnly: Story = {
  args: { bladeAllowed: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Select" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "+ Track" })).toBeTruthy();
    await expect(within(document.body).queryByRole("dialog")).toBeNull();
  },
};

export const Tablet: Story = {
  parameters: { railTablet: true },
};

export const PhoneWidth: Story = {};
