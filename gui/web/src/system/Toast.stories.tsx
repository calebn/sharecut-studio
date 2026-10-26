import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Toast, type ToastState } from "../ui";
import type { SystemIconName } from "./icons";
import { Player } from "./Player";
import { SystemIcon } from "./SystemIcon";

/** Design system lifetimes: 6 s, and 10 s for session-level undo. The app keeps 8 s and 60 s until #2292. */
const DS_TOAST_S = 6;
const DS_SESSION_UNDO_S = 10;

/**
 * Every story holds its toast at rest: the sweep and the screenshots read the
 * page long after the real lifetime, so no auto-dismiss timer may fire.
 */
const REST_MS = 600_000;

type Args = {
  message: string;
  glyph: SystemIconName;
  tone?: ToastState["tone"];
  undo?: boolean;
  undoLabel?: string;
  onUndo: () => void;
  onDismiss: () => void;
};

function ToastOverPlayer({
  message,
  glyph,
  tone,
  undo,
  undoLabel,
  onUndo,
  onDismiss,
}: Args) {
  const [toast, setToast] = useState<ToastState | null>({
    id: 1,
    message,
    tone,
  });
  const [undone, setUndone] = useState(false);
  return (
    <main
      aria-label="Stage"
      style={{
        display: "flex",
        flexDirection: "column",
        minBlockSize: "14rem",
      }}
    >
      <div style={{ flex: 1, padding: "1rem" }}>
        <button
          type="button"
          onClick={() => {
            setUndone(false);
            setToast((t) => ({ id: (t?.id ?? 0) + 1, message, tone }));
          }}
        >
          Show toast
        </button>
      </div>
      <Toast
        className="sys-toast-dock"
        toast={toast}
        timeoutMs={REST_MS}
        icon={<SystemIcon name={glyph} size={16} />}
        undoLabel={undoLabel}
        onUndo={
          undo && !undone
            ? () => {
                setUndone(true);
                setToast((t) => ({
                  id: (t?.id ?? 0) + 1,
                  message: `Undid: ${message}`,
                }));
                onUndo();
              }
            : undefined
        }
        onDismiss={() => {
          setToast(null);
          onDismiss();
        }}
      />
      <Player
        form="bar"
        playing={false}
        time="12:04"
        total="52:10"
        onPlayPause={() => undefined}
      />
    </main>
  );
}

const meta: Meta<Args> = {
  title: "System/Toast",
  tags: ["autodocs"],
  args: {
    message: "Cut 3 words",
    glyph: "scissors",
    undo: true,
    onUndo: fn(),
    onDismiss: fn(),
  },
  render: (args) => <ToastOverPlayer {...args} />,
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component: `One position: centered 12 px above the Player bar. An icon, a past-tense result and at most one action. The design system lifetime is ${DS_TOAST_S} s (paused on hover or focus) and ${DS_SESSION_UNDO_S} s for session-level undo; a new toast replaces the old one and same-kind toasts merge. Wraps \`ui/Toast\`. The app keeps its own 8 s and 60 s constants until the wiring slice (#2292), so these stories hold the toast at rest instead of timing out.\n\n**Motion.** Rises from the dock with \`--motion-panel\` and fades with \`--motion-state\` in the animation pass; not implemented here.`,
      },
    },
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Result: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Cut 3 words")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Undo" })).toBeVisible();
  },
};

/** Undo replaces the toast with its own result; the story ends with a toast on screen. */
export const UndoReplaces: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await expect(args.onUndo).toHaveBeenCalledOnce();
    await expect(canvas.getByText("Undid: Cut 3 words")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Undo" })).toBeNull();
  },
};

export const Merged: Story = {
  args: { message: "3 cuts", undoLabel: "Undo all" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("3 cuts")).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Undo all" }),
    ).toBeVisible();
  },
};

export const SessionUndo: Story = {
  args: { message: "Ended the session", glyph: "door-open" },
};

export const Failure: Story = {
  args: {
    message: "Could not copy the link. Try again.",
    glyph: "octagon-alert",
    tone: "error",
    undo: false,
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Could not copy the link. Try again."),
    ).toBeVisible();
  },
};

export const Phone: Story = {};
