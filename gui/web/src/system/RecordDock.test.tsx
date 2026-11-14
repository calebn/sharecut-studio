import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("host: a paused take shows Stop beside Resume, in place of Pause", async () => {
    const onStop = vi.fn();
    render(
      <RecordDock
        seat="host"
        record={{ ...record, face: "paused" }}
        onStop={onStop}
      />,
    );
    expect(names()).toEqual([
      "Mute",
      "Comment",
      "Resume recording",
      "Stop take",
      "Notes",
      "More",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Stop take" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("host: Stop on a paused take is disabled while a command is in flight", () => {
    render(
      <RecordDock
        seat="host"
        record={{ ...record, face: "paused", busy: true }}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop take" })).toBeDisabled();
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
      <RecordDock
        seat="guest"
        dock={{ kind: "status", text: "Saving · 64% · keep this page open" }}
      />,
    );
    expect(screen.getByText(/Saving · 64%/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mute" })).toBeNull();
  });

  it("Done replaces Leave beside the status line", async () => {
    const onDone = vi.fn();
    render(
      <RecordDock
        seat="guest"
        dock={{
          kind: "done",
          text: "Saved to project. You can close this page.",
        }}
        onDone={onDone}
        onLeave={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Leave room" })).toBeNull();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  describe("a held Leave", () => {
    afterEach(() => vi.useRealTimers());

    it("says why when pressed", () => {
      vi.useFakeTimers();
      const onLeave = vi.fn();
      render(
        <RecordDock
          seat="guest"
          dock={{
            kind: "controls",
            leaveHeld: "You can leave after this take.",
          }}
          onLeave={onLeave}
        />,
      );
      const leave = screen.getByRole("button", { name: "Leave room" });
      expect(leave).toHaveAttribute("aria-disabled", "true");
      expect(leave).toHaveAttribute("title", "You can leave after this take.");
      const note = document.getElementById(
        leave.getAttribute("aria-describedby") ?? "",
      );
      expect(note).toHaveTextContent("You can leave after this take.");
      expect(note).not.toHaveAttribute("data-shown");
      act(() => leave.click());
      expect(onLeave).not.toHaveBeenCalled();
      expect(note).toHaveAttribute("data-shown");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(note).not.toHaveAttribute("data-shown");
    });

    it("gives the reason as its description at rest", () => {
      render(
        <RecordDock
          seat="guest"
          dock={{ kind: "controls", leaveHeld: "Not yet." }}
        />,
      );
      const note = screen
        .getByRole("button", { name: "Leave room" })
        .getAttribute("aria-describedby");
      expect(document.getElementById(note ?? "")).toHaveTextContent("Not yet.");
    });

    it("holds Done the same way", () => {
      const onDone = vi.fn();
      render(
        <RecordDock
          seat="guest"
          dock={{
            kind: "done",
            text: "Saved to project. You can close this page.",
            leaveHeld: "Your recording is still finishing",
          }}
          onDone={onDone}
        />,
      );
      const done = screen.getByRole("button", { name: "Done" });
      expect(done).toHaveAttribute("aria-disabled", "true");
      expect(done).toHaveAccessibleDescription(
        "Your recording is still finishing",
      );
      act(() => done.click());
      expect(onDone).not.toHaveBeenCalled();
    });

    it("stays focusable", () => {
      render(
        <RecordDock
          seat="guest"
          dock={{ kind: "controls", leaveHeld: "Not yet." }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Leave room" }),
      ).not.toBeDisabled();
    });
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
