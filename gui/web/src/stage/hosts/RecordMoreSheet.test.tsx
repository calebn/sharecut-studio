import { render, screen } from "@testing-library/react";
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
  it("shows why it cannot end yet and ties the button to the reason", () => {
    sheet({ endReason: "Stop the take first." });
    const button = screen.getByRole("button", { name: "End session" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Stop the take first.");
    const reason = screen.getByText("Stop the take first.", { selector: "p" });
    expect(reason).toBeVisible();
    expect(button).toHaveAttribute("aria-describedby", reason.id);
  });

  it("shows no note when it can end", () => {
    sheet();
    const button = screen.getByRole("button", { name: "End session" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
  });
});
