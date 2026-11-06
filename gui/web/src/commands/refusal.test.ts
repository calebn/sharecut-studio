import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { announceRefusal, runAndAnnounceRefusal } from "./refusal";
import type { ExecuteResult } from "./types";

afterEach(() => vi.restoreAllMocks());

function told() {
  const s = useDawStore.getState();
  return { text: s.statusAnnouncement, tone: s.feedbackToast?.tone };
}

describe("runAndAnnounceRefusal", () => {
  beforeEach(() => {
    useDawStore.getState().announceStatus("");
    vi.clearAllMocks();
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

  it("keeps a told command's own announcement that carries the reason", async () => {
    await runAndAnnounceRefusal(async () => {
      useDawStore
        .getState()
        .announceStatus("Delete failed: the clip is locked", { tone: "error" });
      return { status: "disabled", reason: "the clip is locked", told: true };
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

  it("does not let an unrelated error hide a pending untold refusal", async () => {
    const pending = deferred<ExecuteResult>();
    const result = runAndAnnounceRefusal(() => pending.promise);
    useDawStore
      .getState()
      .announceStatus("An unrelated export failed", { tone: "error" });
    pending.resolve({ status: "disabled", reason: "Nothing selected" });
    await result;
    expect(told()).toEqual({ text: "Nothing selected", tone: "error" });
  });

  it("does not infer ownership from matching text announced during the run", async () => {
    const pending = deferred<ExecuteResult>();
    const result = runAndAnnounceRefusal(() => pending.promise);
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    useDawStore.getState().announceStatus("Another action: Nothing selected");
    pending.resolve({ status: "disabled", reason: "Nothing selected" });
    await result;

    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith("Nothing selected", {
      tone: "error",
    });
    expect(told()).toEqual({ text: "Nothing selected", tone: "error" });
  });

  it.each(["", "   "])(
    "does not publish an empty refusal %j",
    async (reason) => {
      useDawStore.getState().announceStatus("Ready");
      const seq = useDawStore.getState().statusAnnouncementSeq;
      await runAndAnnounceRefusal(async () => ({ status: "disabled", reason }));
      expect(useDawStore.getState().statusAnnouncement).toBe("Ready");
      expect(useDawStore.getState().statusAnnouncementSeq).toBe(seq);
    },
  );

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
      return { status: "disabled", reason, told: true };
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

describe("announceRefusal", () => {
  beforeEach(() => {
    useDawStore.getState().announceStatus("");
    vi.clearAllMocks();
  });

  it("returns each result by identity and only announces a nonblank untold refusal", () => {
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    const results: ExecuteResult[] = [
      { status: "ok" },
      { status: "unknown" },
      { status: "disabled", reason: "Already handled", told: true },
      { status: "disabled", reason: "" },
      { status: "disabled", reason: "   " },
    ];

    for (const result of results) expect(announceRefusal(result)).toBe(result);
    const refusal = { status: "disabled", reason: "Original reason" } as const;

    expect(announceRefusal(refusal)).toBe(refusal);
    expect(announce).toHaveBeenCalledExactlyOnceWith("Original reason", {
      tone: "error",
    });
  });

  it("preserves the result identity after publishing and propagates rejection", async () => {
    const results: ExecuteResult[] = [
      { status: "ok" },
      { status: "unknown" },
      { status: "disabled", reason: "Nothing selected" },
    ];
    for (const result of results)
      expect(await runAndAnnounceRefusal(async () => result)).toBe(result);

    const error = new Error("command rejected");
    await expect(
      runAndAnnounceRefusal(async () => Promise.reject(error)),
    ).rejects.toBe(error);
  });
});
