import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecordMoreSheet, type RecordMoreSheetProps } from "./RecordMoreSheet";

function sheet(overrides: Partial<RecordMoreSheetProps> = {}) {
  return render(
    <RecordMoreSheet
      open
      onClose={vi.fn()}
      busy={false}
      upload={{
        acked: 0,
        total: 0,
        fileAck: false,
        landed: false,
        landFailed: false,
        reclaimFailed: false,
        uploading: false,
        pending: false,
        recoverable: false,
        error: null,
        segments: [],
      }}
      keeperActions={undefined}
      stopped={false}
      onResumeUpload={vi.fn()}
      removedInvite={false}
      onInvite={vi.fn()}
      guestsSeeNotes
      onGuestsSeeNotesChange={vi.fn()}
      onDevices={vi.fn()}
      onRoomTone={vi.fn()}
      micOn
      onMicChange={vi.fn()}
      onEndSession={vi.fn()}
      {...overrides}
    />,
  );
}

describe("RecordMoreSheet End session", () => {
  it("stays focusable and says why it cannot end yet", () => {
    sheet({ endReason: "Stop the take first." });
    const button = screen.getByRole("button", { name: "End session" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAccessibleDescription("Stop the take first.");
    const reason = screen.getByText("Stop the take first.", { selector: "p" });
    expect(reason).toBeVisible();
    expect(button).toHaveAttribute("aria-describedby", reason.id);
    button.focus();
    expect(button).toHaveFocus();
  });

  it.each([
    [
      "click",
      async () =>
        userEvent.click(screen.getByRole("button", { name: "End session" })),
    ],
    ["Enter", async () => userEvent.keyboard("{Enter}")],
    ["Space", async () => userEvent.keyboard(" ")],
  ])(
    "does nothing on %s while gated and keeps the sheet open",
    async (_name, act) => {
      const onClose = vi.fn();
      const onEndSession = vi.fn();
      sheet({ endReason: "Stop the take first.", onClose, onEndSession });
      await screen.findByRole("dialog");
      await new Promise((resolve) => setTimeout(resolve, 0));
      screen.getByRole("button", { name: "End session" }).focus();
      await act();
      expect(onClose).not.toHaveBeenCalled();
      expect(onEndSession).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );

  it("gates a whitespace-only reason with the generic note", () => {
    sheet({ endReason: "   " });
    const button = screen.getByRole("button", { name: "End session" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription(
      "This action is unavailable right now.",
    );
  });

  it("shows no note and ends the session when it can end", async () => {
    const onClose = vi.fn();
    const onEndSession = vi.fn();
    sheet({ onClose, onEndSession });
    const button = screen.getByRole("button", { name: "End session" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("aria-describedby");
    await userEvent.click(button);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onEndSession).toHaveBeenCalledOnce();
  });
});
