import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../../state/dawStore";
import {
  announceAfterNextStatus,
  QUIET_EDIT_FALLBACK_MS,
} from "./announceAfterNextStatus";

const REMINDER = "You changed the host's episode, and everyone sees it.";

beforeEach(() => {
  vi.useFakeTimers();
  useDawStore.getState().announceStatus("", { toast: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("announceAfterNextStatus", () => {
  it("leaves the edit's own status in the slot until it speaks, then says the reminder last", async () => {
    announceAfterNextStatus(REMINDER);
    expect(useDawStore.getState().statusAnnouncement).toBe("");

    useDawStore.getState().announceStatus('Cut "uncle" · 0.3 s');
    expect(useDawStore.getState().statusAnnouncement).toBe(
      'Cut "uncle" · 0.3 s',
    );
    await Promise.resolve();
    expect(useDawStore.getState().statusAnnouncement).toBe(REMINDER);
    expect(useDawStore.getState().feedbackToast?.message).toBe(
      'Cut "uncle" · 0.3 s',
    );
  });

  it("says it once, however many statuses follow", async () => {
    announceAfterNextStatus(REMINDER);
    useDawStore.getState().announceStatus("Saved", { toast: false });
    await Promise.resolve();
    const spokenAt = useDawStore.getState().statusAnnouncementSeq;
    useDawStore.getState().announceStatus("Saved again", { toast: false });
    vi.advanceTimersByTime(QUIET_EDIT_FALLBACK_MS);
    expect(useDawStore.getState().statusAnnouncement).toBe("Saved again");
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(spokenAt + 1);
  });

  it("says it after a quiet spell when the edit announces nothing", () => {
    announceAfterNextStatus(REMINDER);
    vi.advanceTimersByTime(QUIET_EDIT_FALLBACK_MS - 1);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    vi.advanceTimersByTime(1);
    expect(useDawStore.getState().statusAnnouncement).toBe(REMINDER);
  });
});
