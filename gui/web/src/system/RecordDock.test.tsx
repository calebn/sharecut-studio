import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordDock } from "./RecordDock";

const record = { face: "idle", onStart: vi.fn(), onStop: vi.fn() } as const;
const names = () =>
  screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));

describe("RecordDock", () => {
  it("host: Mute, Comment, Record, Comments, More; Pause only while a take runs", () => {
    const { rerender } = render(<RecordDock seat="host" record={record} />);
    expect(names()).toEqual(["Mute", "Comment", "Record", "Comments", "More"]);
    rerender(<RecordDock seat="host" record={{ ...record, face: "live" }} />);
    expect(names()).toEqual([
      "Mute",
      "Comment",
      "Stop take",
      "Pause take",
      "Comments",
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
      "Comments",
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

  it("guest: Mute is the 64 px primary, then Comment, Comments, Leave", () => {
    render(<RecordDock seat="guest" />);
    expect(names()).toEqual(["Mute", "Comment", "Comments", "Leave room"]);
    expect(screen.getByRole("button", { name: "Mute" })).toHaveClass(
      "sys-dock-btn--primary",
    );
  });

  it("producer: Comment is the primary; no Mute", () => {
    render(<RecordDock seat="producer" />);
    expect(names()).toEqual(["Comment", "Comments", "Leave room"]);
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

  it("counts unread comments in the name", () => {
    render(<RecordDock seat="guest" unreadNotes={3} />);
    expect(
      screen.getByRole("button", { name: "Comments, 3 unread" }),
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
    expect(
      screen.getByRole("button", { name: "Comments" }),
    ).toBeInTheDocument();
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

    it("holds Done for the same reason as Leave", () => {
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
      expect(done).toHaveAttribute(
        "title",
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
    expect(names()).toEqual(["Mute", "Record", "Comments", "More"]);
    rerender(<RecordDock seat="guest" showComment={false} />);
    expect(names()).toEqual(["Mute", "Comments", "Leave room"]);
    rerender(<RecordDock seat="producer" showComment={false} />);
    expect(names()).toEqual(["Comments", "Leave room"]);
  });

  it("a host seat without a record prop keeps the host controls but no Record or Pause", () => {
    render(<RecordDock seat="host" />);
    expect(names()).toEqual(["Mute", "Comment", "Comments", "More"]);
    expect(screen.queryByRole("button", { name: "Record" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause take" })).toBeNull();
  });

  describe("labelled phone dock", () => {
    const visibleWords = () =>
      [...document.querySelectorAll(".sys-dock-label")].map(
        (label) => label.textContent,
      );

    it("prints Mute, Comment and Leave under their discs, names unchanged", () => {
      render(<RecordDock seat="guest" labelled notes={false} />);
      expect(visibleWords()).toEqual(["Mute", "Comment", "Leave"]);
      expect(names()).toEqual(["Mute", "Comment", "Leave room"]);
      for (const label of document.querySelectorAll(".sys-dock-label")) {
        expect(label).toHaveAttribute("aria-hidden", "true");
        expect(label.closest("button")).not.toBeNull();
      }
      expect(document.querySelector(".sys-dock")).toHaveAttribute(
        "data-labelled",
      );
    });

    it("says Unmute when muted", () => {
      render(<RecordDock seat="guest" muted labelled notes={false} />);
      expect(visibleWords()).toEqual(["Unmute", "Comment", "Leave"]);
    });

    it("a producer's dock is Comment and Leave", () => {
      render(<RecordDock seat="producer" labelled notes={false} />);
      expect(visibleWords()).toEqual(["Comment", "Leave"]);
    });

    it("a held Leave keeps its word and its reason", () => {
      render(
        <RecordDock
          seat="guest"
          labelled
          notes={false}
          dock={{
            kind: "controls",
            leaveHeld: "You can leave after this take.",
          }}
        />,
      );
      const leave = screen.getByRole("button", { name: "Leave room" });
      expect(leave).toHaveAttribute("aria-disabled", "true");
      expect(leave).toHaveTextContent("Leave");
    });

    it("has no Comments toggle in controls, status or done mode", () => {
      const { rerender } = render(<RecordDock seat="guest" notes={false} />);
      const toggle = () => screen.queryByRole("button", { name: /^Comments/ });
      expect(toggle()).toBeNull();
      rerender(
        <RecordDock
          seat="guest"
          notes={false}
          dock={{ kind: "status", text: "Saving" }}
        />,
      );
      expect(toggle()).toBeNull();
      rerender(
        <RecordDock
          seat="guest"
          notes={false}
          dock={{ kind: "done", text: "Saved to project." }}
        />,
      );
      expect(toggle()).toBeNull();
      expect(screen.getByRole("button", { name: "Done" })).toBeVisible();
    });
  });

  it("an unlabelled dock keeps its Comments toggle and prints no words", () => {
    render(<RecordDock seat="host" record={record} />);
    expect(
      screen.getByRole("button", { name: "Comments" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".sys-dock-label")).toBeNull();
    expect(document.querySelector(".sys-dock")).not.toHaveAttribute(
      "data-labelled",
    );
  });
});
