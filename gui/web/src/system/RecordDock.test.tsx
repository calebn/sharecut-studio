import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecordDock } from "./RecordDock";

const record = { face: "idle", onStart: vi.fn(), onStop: vi.fn() } as const;
const names = () =>
  screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("RecordDock", () => {
  it("host: Mute, Comment, Record, Notes, More; Pause only while a take runs", () => {
    const { rerender } = render(<RecordDock seat="host" record={record} />);
    expect(names()).toEqual(["Mute", "Comment", "Record", "Notes", "More"]);
    rerender(<RecordDock seat="host" record={{ ...record, face: "live" }} />);
    expect(names()).toEqual([
      "Mute",
      "Comment",
      "Stop take",
      "Pause take",
      "Notes",
      "More",
    ]);
  });

  it("guest: Mute is the 64 px primary, then Comment, Notes, Leave", () => {
    render(<RecordDock seat="guest" />);
    expect(names()).toEqual(["Mute", "Comment", "Notes", "Leave room"]);
    expect(screen.getByRole("button", { name: "Mute" })).toHaveClass(
      "sys-dock-btn--primary",
    );
  });

  it("producer: Comment is the primary; no Mute", () => {
    render(<RecordDock seat="producer" />);
    expect(names()).toEqual(["Comment", "Notes", "Leave room"]);
    expect(screen.getByRole("button", { name: "Comment" })).toHaveClass(
      "sys-dock-btn--primary",
    );
  });

  it("a muted guest sees Unmute pressed, and Mute calls back", async () => {
    const onMute = vi.fn();
    render(<RecordDock seat="guest" muted onMute={onMute} />);
    const button = screen.getByRole("button", { name: "Unmute" });
    await userEvent.click(button);
    expect(onMute).toHaveBeenCalledTimes(1);
  });

  it("counts unread notes in the name", () => {
    render(<RecordDock seat="guest" unreadNotes={3} />);
    expect(
      screen.getByRole("button", { name: "Notes, 3 unread" }),
    ).toBeInTheDocument();
  });

  it("a status line replaces the secondaries after Stop", () => {
    render(
      <RecordDock seat="guest" status="Saving · 64% · keep this page open" />,
    );
    expect(screen.getByText(/Saving · 64%/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mute" })).toBeNull();
  });

  it("Leave is held back while saving, with the reason", () => {
    render(
      <RecordDock
        seat="guest"
        leaveDisabledReason="Your recording is still saving"
      />,
    );
    const leave = screen.getByRole("button", { name: "Leave room" });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAttribute("title", "Your recording is still saving");
  });

  it("hides Comment while the room waits, for every seat", () => {
    const { rerender } = render(
      <RecordDock seat="host" record={record} showComment={false} />,
    );
    expect(names()).toEqual(["Mute", "Record", "Notes", "More"]);
    rerender(<RecordDock seat="guest" showComment={false} />);
    expect(names()).toEqual(["Mute", "Notes", "Leave room"]);
    rerender(<RecordDock seat="producer" showComment={false} />);
    expect(names()).toEqual(["Notes", "Leave room"]);
  });

  it("a host seat without a record prop keeps the host controls but no Record or Pause", () => {
    render(<RecordDock seat="host" />);
    expect(names()).toEqual(["Mute", "Comment", "Notes", "More"]);
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause take" })).toBeNull();
  });
});
