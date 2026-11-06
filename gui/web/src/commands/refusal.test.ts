import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { runAndAnnounceRefusal } from "./refusal";
import type { ExecuteResult } from "./types";

function told() {
  const s = useDawStore.getState();
  return { text: s.statusAnnouncement, tone: s.feedbackToast?.tone };
}

describe("runAndAnnounceRefusal", () => {
  beforeEach(() => {
    useDawStore.getState().announceStatus("");
  });

  it("announces a refusal at error tone", async () => {
    const result = await runAndAnnounceRefusal(async () => ({
      status: "disabled",
      reason: "Refresh already running",
    }));
    expect(result.status).toBe("disabled");
    expect(told()).toEqual({ text: "Refresh already running", tone: "error" });
  });

  it("leaves a failure the command already told in its own words", async () => {
    await runAndAnnounceRefusal(async () => {
      useDawStore
        .getState()
        .announceStatus("Refresh failed: a track file is missing", {
          tone: "error",
        });
      return {
        status: "disabled",
        reason: "a track file is missing",
        told: true,
      };
    });
    expect(told().text).toBe("Refresh failed: a track file is missing");
  });

  it("keeps a command's own announcement that carries the reason, without a told flag", async () => {
    await runAndAnnounceRefusal(async () => {
      useDawStore
        .getState()
        .announceStatus("Delete failed: the clip is locked", { tone: "error" });
      return { status: "disabled", reason: "the clip is locked" };
    });
    expect(told().text).toBe("Delete failed: the clip is locked");
  });

  it("does not let an unrelated announcement hide a refusal", async () => {
    await runAndAnnounceRefusal(async () => {
      useDawStore.getState().announceStatus("Mix preview refreshed");
      return { status: "disabled", reason: "Nothing selected" };
    });
    expect(told()).toEqual({ text: "Nothing selected", tone: "error" });
  });

  it("announces a repeated refusal again after an earlier identical one", async () => {
    const refuse = async (): Promise<ExecuteResult> => ({
      status: "disabled",
      reason: "Nothing selected",
    });
    await runAndAnnounceRefusal(refuse);
    const seq = useDawStore.getState().statusAnnouncementSeq;
    const toast = useDawStore.getState().feedbackToast;
    if (toast) useDawStore.getState().dismissFeedbackToast(toast.id);
    await runAndAnnounceRefusal(refuse);
    expect(useDawStore.getState().statusAnnouncement).toBe("Nothing selected");
    expect(useDawStore.getState().statusAnnouncementSeq).toBeGreaterThan(seq);
  });

  it("keeps an own announcement that error tone rewrote", async () => {
    const reason = "write failed at /home/u/proj/a/b.wav";
    const before = useDawStore.getState().statusAnnouncementSeq;
    await runAndAnnounceRefusal(async () => {
      useDawStore.getState().announceStatus(`Delete failed: ${reason}`, {
        tone: "error",
      });
      return { status: "disabled", reason };
    });
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(before + 1);
    expect(told().text).not.toContain("/home/u");
  });

  it("stays quiet for ok and unknown results", async () => {
    for (const result of [
      { status: "ok" },
      { status: "unknown" },
    ] as ExecuteResult[]) {
      await runAndAnnounceRefusal(async () => result);
    }
    expect(told().text).toBe("");
  });
});
