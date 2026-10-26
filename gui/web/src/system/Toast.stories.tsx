import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Toast, type ToastState } from "../ui";
import { Player } from "./Player";

/** DS targets: 6 s, and 10 s for session-level undo. The app keeps 8 s and 60 s until #2292. */
const DS_TOAST_MS = 6000;
const DS_SESSION_UNDO_MS = 10_000;

type Args = {
  message: string;
  timeoutMs: number;
  tone?: ToastState["tone"];
  undo?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
};

function ToastOverPlayer({
  message,
  timeoutMs,
  tone,
  undo,
  onUndo,
  onDismiss,
}: Args) {
  const [toast, setToast] = useState<ToastState | null>({
    id: 1,
    message,
    tone,
  });
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
          onClick={() =>
            setToast((t) => ({ id: (t?.id ?? 0) + 1, message, tone }))
          }
        >
          Show toast
        </button>
      </div>
      <Toast
        className="sys-toast-dock"
        toast={toast}
        timeoutMs={timeoutMs}
        onUndo={
          undo
            ? () => {
                setToast(null);
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
    timeoutMs: DS_TOAST_MS,
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
        component:
          "One position: centered 12 px above the Player bar. Icon-free past-tense result and at most one action. Lasts 6 s (paused on hover or focus) and 10 s for session-level undo; a new toast replaces the old one and same-kind toasts merge. Wraps `ui/Toast` with `timeoutMs` as a prop; the app still uses 8 s and 60 s until the wiring slice (#2292).\n\n**Motion.** Rises from the dock with `--motion-panel` and fades with `--motion-state` in the animation pass; not implemented here.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Result: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await expect(args.onUndo).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(canvasElement.querySelector(".ui-toast")).toBeNull(),
    );
  },
};

export const Merged: Story = { args: { message: "3 cuts" } };

export const SessionUndo: Story = {
  args: { message: "Ended the session", timeoutMs: DS_SESSION_UNDO_MS },
};

export const Failure: Story = {
  args: {
    message: "Could not copy the link. Try again.",
    tone: "error",
    undo: false,
  },
};

export const Phone: Story = {};
