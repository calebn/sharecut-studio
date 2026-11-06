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
