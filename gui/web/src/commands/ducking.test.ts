import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { duckingBlocker } from "./ducking";
import { duckingReplanCount } from "./duckingReplan";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  previewDucking: vi.fn(),
  applyDuckingCommand: vi.fn(),
}));

const HEAD = "h1" as HistoryEntryId;

const track = (id: string, changed: boolean, replacedEarlierDips = 0) => ({
  trackId: id,
  changed,
  replacedEarlierDips,
  simplified: false,
});
const plan = (...tracks: ReturnType<typeof track>[]) => ({
  planToken: "tok-1",
  depthDb: -18,
  tracks,
});
const outcome = (applied: boolean, ...tracks: ReturnType<typeof track>[]) => ({
  ...plan(...tracks),
  applied,
  historyHead: applied ? HEAD : null,
  queued: false,
});

const toast = () => useDawStore.getState().feedbackToast;

describe("track.duckUnderSpeech", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.previewDucking).mockReset();
    vi.mocked(api.applyDuckingCommand).mockReset();
    useDawStore.getState().hydrate("/tmp/ep.json", minimalProject());
    useDawStore.setState({
      feedbackToast: null,
      guestMode: null,
      shareCapabilities: null,
    });
  });

  it("applies the token of the plan the inspector showed, without planning again, and offers Undo", async () => {
    vi.mocked(api.applyDuckingCommand).mockResolvedValue(
      outcome(true, track("m1", true), track("m2", true)),
    );
    expect(
      await execute(
        "track.duckUnderSpeech",
        { planToken: "tok-1" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "ok" });
    expect(api.previewDucking).not.toHaveBeenCalled();
    expect(api.applyDuckingCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "tok-1",
    );
    expect(toast()?.message).toBe(
      "Music now lowers under speech on 2 music tracks. Hear it once the mix refreshes, in play or export.",
    );
    expect(useDawStore.getState().feedbackToast?.undo).toBe(HEAD);
  });

  it("from the palette plans first, then applies exactly that plan", async () => {
    vi.mocked(api.previewDucking).mockResolvedValue(plan(track("m1", true)));
    vi.mocked(api.applyDuckingCommand).mockResolvedValue(
      outcome(true, track("m1", true)),
    );
    await execute("track.duckUnderSpeech", {}, { skipWhen: true });
    expect(api.previewDucking).toHaveBeenCalledWith("/tmp/ep.json");
    expect(api.applyDuckingCommand).toHaveBeenCalledWith(
      "/tmp/ep.json",
      "tok-1",
    );
    expect(toast()?.message).toContain("on 1 music track.");
  });

  it("says the music already follows the speech, and sends no apply, when the plan changes nothing", async () => {
    vi.mocked(api.previewDucking).mockResolvedValue(plan(track("m1", false)));
    expect(
      await execute("track.duckUnderSpeech", {}, { skipWhen: true }),
    ).toEqual({ status: "ok" });
    expect(api.applyDuckingCommand).not.toHaveBeenCalled();
    expect(toast()?.message).toBe("Music already follows the speech.");
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("reports an apply the host found nothing to change as current, with no Undo", async () => {
    vi.mocked(api.applyDuckingCommand).mockResolvedValue(
      outcome(false, track("m1", false)),
    );
    await execute(
      "track.duckUnderSpeech",
      { planToken: "tok-1" },
      { skipWhen: true },
    );
    expect(toast()?.message).toBe("Music already follows the speech.");
    expect(toast()?.undo ?? null).toBeNull();
  });

  it.each([
    [
      "ducking_no_targets",
      400,
      "There is no music to lower: none is added, or every music track is muted or silent. Add or unmute one.",
    ],
    [
      "ducking_no_dialogue_activity",
      400,
      "There is no transcribed speech to lower music under yet. Transcribe the episode first.",
    ],
    ["document_conflict", 409, "The episode changed. Check again."],
  ])("tells a %s refusal in plain words", async (code, status, text) => {
    vi.mocked(api.previewDucking).mockRejectedValue(
      new ApiError("server words", code, status),
    );
    expect(
      await execute("track.duckUnderSpeech", {}, { skipWhen: true }),
    ).toEqual({ status: "disabled", reason: text, told: true });
    expect(toast()?.message).toBe(text);
    expect(toast()?.message).not.toMatch(/not found/i);
  });

  it("asks the inspector to plan again on a stale token, so the dead token is not resent", async () => {
    vi.mocked(api.applyDuckingCommand).mockRejectedValue(
      new ApiError("The project changed", "document_conflict", 409),
    );
    const before = duckingReplanCount();
    await execute(
      "track.duckUnderSpeech",
      { planToken: "old" },
      { skipWhen: true },
    );
    expect(duckingReplanCount()).toBe(before + 1);
  });

  it("tells the host's refusal in its own words, without a connectivity claim", async () => {
    vi.mocked(api.previewDucking).mockRejectedValue(
      new ApiError("Too many dips.", "ducking_too_many_points", 400),
    );
    await execute("track.duckUnderSpeech", {}, { skipWhen: true });
    expect(toast()?.message).toBe("Too many dips.");
    expect(toast()?.message).not.toMatch(/could not check|not found/i);
  });

  it("shows the stale-token toast and applies nothing more", async () => {
    vi.mocked(api.applyDuckingCommand).mockRejectedValue(
      new ApiError("The project changed", "document_conflict", 409),
    );
    await execute(
      "track.duckUnderSpeech",
      { planToken: "old" },
      { skipWhen: true },
    );
    expect(toast()?.message).toBe("The episode changed. Check again.");
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("shows the host's own words for a failure that is not a state of the episode", async () => {
    vi.mocked(api.previewDucking).mockRejectedValue(
      new ApiError("Too many dips to save.", "ducking_too_many_points", 400),
    );
    await execute("track.duckUnderSpeech", {}, { skipWhen: true });
    expect(toast()?.message).toBe("Too many dips to save.");
  });

  it("does not run twice at once", async () => {
    let release: (v: ReturnType<typeof outcome>) => void = () => {};
    vi.mocked(api.applyDuckingCommand).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = execute(
      "track.duckUnderSpeech",
      { planToken: "t" },
      { skipWhen: true },
    );
    expect(
      await execute(
        "track.duckUnderSpeech",
        { planToken: "t" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "disabled", reason: "Ducking is already running" });
    release(outcome(true, track("m1", true)));
    await first;
    expect(api.applyDuckingCommand).toHaveBeenCalledTimes(1);
  });

  it("tells a send that waits in the queue, and claims no Undo", async () => {
    vi.mocked(api.applyDuckingCommand).mockResolvedValue({
      ...outcome(false),
      queued: true,
    });
    await execute(
      "track.duckUnderSpeech",
      { planToken: "t" },
      { skipWhen: true },
    );
    expect(toast()?.message).toBe(
      "Studio is out of reach. Ducking is queued and will try to apply when it is back.",
    );
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("refuses a link that is not the host, before any request", async () => {
    useDawStore.getState().hydrate(shareProjectKey("tok"), minimalProject());
    expect(
      await execute("track.duckUnderSpeech", {}, { skipWhen: true }),
    ).toEqual({ status: "disabled", reason: "Only the host can duck music" });
    expect(api.previewDucking).not.toHaveBeenCalled();
  });
});

describe("duckingBlocker", () => {
  it("names who can duck", () => {
    expect(duckingBlocker(true, true)).toBeNull();
    expect(duckingBlocker(false, true)).toBe("Only the host can duck music");
    expect(duckingBlocker(true, false)).toBe(
      "Only the host and editors can change the mix",
    );
  });
});
