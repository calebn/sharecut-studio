import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "./dawStore";
import { justAnnounced } from "./uiSlice";

const say = (message: string, options = {}) =>
  useDawStore.getState().announceStatus(message, options);
const toast = () => useDawStore.getState().feedbackToast;

describe("announceStatus repeats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDawStore.setState({ feedbackToast: null });
  });
  afterEach(() => vi.useRealTimers());

  it("absorbs the same text told again at once and keeps the first tone", () => {
    say("Reorder failed: set PODCAST_MCP_FFMPEG.", { tone: "error" });
    const first = toast();
    const seq = useDawStore.getState().statusAnnouncementSeq;
    say(
      "Reorder failed. Export diagnostics from the command palette and try again.",
    );
    expect(toast()).toBe(first);
    expect(toast()?.tone).toBe("error");
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(seq);
  });

  it("shows a different text as its own toast", () => {
    say("First");
    const first = toast();
    say("Second");
    expect(toast()?.message).toBe("Second");
    expect(toast()?.id).not.toBe(first?.id);
  });

  it("treats the same text after the window as a genuine repeat", () => {
    say("Nothing selected");
    const first = toast();
    vi.advanceTimersByTime(1100);
    say("Nothing selected");
    expect(toast()?.id).not.toBe(first?.id);
  });

  it("does not absorb a repeat that carries its own Undo", () => {
    say("Deleted clip", { undo: "h1" });
    say("Deleted clip", { undo: "h2" });
    expect(toast()?.undo).toBe("h2");
  });

  it("knows a message was spoken only inside the window", () => {
    say("Can't undo", { toast: false, tone: "error" });
    expect(justAnnounced("Can't undo")).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(justAnnounced("Can't undo")).toBe(false);
  });

  it("absorbs a toast repeat of a refusal a handler spoke without one", () => {
    say("Moved clips", { undo: "h1" });
    const standing = toast();
    say("Nothing to do", { toast: false, tone: "error" });
    say("Nothing to do");
    expect(toast()).toBe(standing);
  });

  it("shows a gesture message again at once after the gesture ended", () => {
    say("Clip armed: drag sideways", { gesture: true });
    useDawStore.getState().endGestureFeedback();
    say("Clip armed: drag sideways", { gesture: true });
    expect(toast()?.message).toBe("Clip armed: drag sideways");
  });

  it("does not absorb a gesture message that repeats while it stands", () => {
    say("Clip armed", { gesture: true });
    const first = toast();
    say("Clip armed", { gesture: true });
    expect(toast()?.id).not.toBe(first?.id);
  });

  it("shows a refusal again when its toast was dismissed", () => {
    say("Nothing selected", { tone: "error" });
    useDawStore.getState().dismissFeedbackToast(toast()!.id);
    say("Nothing selected", { tone: "error" });
    expect(toast()?.message).toBe("Nothing selected");
  });

  it("shows a toast for text first spoken silently as a status", () => {
    say("Needs attention", { toast: false });
    say("Needs attention");
    expect(toast()?.message).toBe("Needs attention");
  });
});
