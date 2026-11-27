import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberFrozenReview } from "../api/project";
import {
  resetShuttleEscalation,
  shuttleBack,
  shuttleForward,
} from "../commands/shuttle";
import { confirmDeadLink } from "../hooks/useDeadLinkWatch";
import { shareProjectKey } from "../shareMode";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { PLAYBACK_SPEED_STORAGE_KEY } from "../utils/playbackSpeedPref";
import { useDawStore } from "./dawStore";
import { effectiveChosen, playbackSpeedAvailable } from "./playbackSpeed";

const s = () => useDawStore.getState();
const HOST = "/tmp/p.json";

function hydrateHost() {
  s().hydrate(HOST, minimalProject({ tracks: [sampleTrack()] }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetShuttleEscalation();
  rememberFrozenReview("tok", false);
  useDawStore.setState({ chosenPlaybackRate: 1, followingClientId: null });
  hydrateHost();
});

afterEach(() => {
  vi.useRealTimers();
  rememberFrozenReview("tok", false);
  localStorage.clear();
  useDawStore.setState({ chosenPlaybackRate: 1, playbackRate: 1 });
});

describe("playbackSpeedAvailable", () => {
  it("is true for a host path, a frozen review and false for a live share key", () => {
    expect(playbackSpeedAvailable(HOST)).toBe(true);
    expect(playbackSpeedAvailable("")).toBe(true);
    expect(playbackSpeedAvailable(shareProjectKey("tok"))).toBe(false);
    rememberFrozenReview("tok", true);
    expect(playbackSpeedAvailable(shareProjectKey("tok"))).toBe(true);
    rememberFrozenReview("tok", false);
    expect(playbackSpeedAvailable(shareProjectKey("tok"))).toBe(false);
  });
});

describe("a frozen-review flip with no hydrate (confirmDeadLink -> loadReviewBootstrap)", () => {
  const bootstrap = (frozen: boolean) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              capabilities: ["view"],
              reads_transcript_words: false,
              frozen_review_view: frozen,
              meta: {},
            }),
          ),
      ),
    );
  afterEach(() => vi.unstubAllGlobals());

  it("live to frozen re-applies the chosen speed", async () => {
    s().setPlaybackSpeed(1.5);
    s().hydrate(shareProjectKey("tok"), minimalProject());
    expect(s().playbackRate).toBe(1);
    bootstrap(true);
    await confirmDeadLink("tok");
    expect(s().playbackRate).toBe(1.5);
    s().setIsPlaying(true);
    expect(s().playbackRate).toBe(1.5);
  });

  it("frozen to live returns the rate to 1", async () => {
    rememberFrozenReview("tok", true);
    s().setPlaybackSpeed(1.5);
    s().hydrate(shareProjectKey("tok"), minimalProject());
    expect(s().playbackRate).toBe(1.5);
    bootstrap(false);
    await confirmDeadLink("tok");
    expect(s().playbackRate).toBe(1);
    s().setIsPlaying(true);
    expect(s().playbackRate).toBe(1);
  });

  it("leaves a scan and a follow alone", async () => {
    s().setPlaybackSpeed(1.5);
    s().hydrate(shareProjectKey("tok"), minimalProject());
    useDawStore.setState({ isPlaying: true, playbackRate: 2 });
    bootstrap(true);
    await confirmDeadLink("tok");
    expect(s().playbackRate).toBe(2);
    rememberFrozenReview("tok", false);
    useDawStore.setState({
      isPlaying: false,
      followingClientId: "x",
      playbackRate: 1.25,
    });
    bootstrap(true);
    await confirmDeadLink("tok");
    expect(s().playbackRate).toBe(1.25);
  });
});

describe("setPlaybackSpeed", () => {
  it("sets the chosen and the playing rate, persists, and announces", () => {
    s().setPlaybackSpeed(1.5);
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 1.5]);
    expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBe("1.5");
    expect(s().statusAnnouncement).toBe("Playback speed 1.5×");
  });

  it("ignores a value that is not a preset", () => {
    s().setPlaybackSpeed(3);
    s().setPlaybackSpeed(1.3);
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1, 1]);
    expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBeNull();
  });

  it("cycles 1, 1.25, 1.5, 2 and wraps", () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      s().cyclePlaybackSpeed();
      seen.push(s().chosenPlaybackRate);
    }
    expect(seen).toEqual([1.25, 1.5, 2, 1, 1.25]);
  });

  it("ends a scan and takes the next preset", () => {
    s().setPlaybackSpeed(1.5);
    useDawStore.setState({ playbackRate: 4 });
    s().cyclePlaybackSpeed();
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([2, 2]);
  });

  it("refuses while following and keeps the stored speed", () => {
    s().setPlaybackSpeed(1.25);
    useDawStore.setState({ followingClientId: "leader", playbackRate: 1.02 });
    s().setPlaybackSpeed(2);
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.25, 1.02]);
    expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBe("1.25");
    expect(s().statusAnnouncement).toBe(
      "Speed follows the person you're following.",
    );
  });

  it("refuses on a live Editor link and never stores", () => {
    s().hydrate(shareProjectKey("tok"), minimalProject());
    s().setPlaybackSpeed(2);
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1, 1]);
    expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBeNull();
    expect(s().statusAnnouncement).toBe(
      "Speed isn't available on live-episode links yet.",
    );
  });
});

describe("a chosen speed survives every reset site", () => {
  beforeEach(() => {
    s().setPlaybackSpeed(1.5);
  });

  it("Play through togglePlaying keeps it, and so does Pause", () => {
    s().togglePlaying();
    expect([s().isPlaying, s().playbackRate]).toEqual([true, 1.5]);
    s().togglePlaying();
    expect([s().isPlaying, s().playbackRate]).toEqual([false, 1.5]);
  });

  it("setIsPlaying(false), Stop and beginAudition return a scan to it", () => {
    for (const reset of [
      () => s().setIsPlaying(false),
      () => s().stopPlayback(),
      () => s().beginAudition({ playheadSec: 1, untilSec: 2 }),
    ]) {
      useDawStore.setState({ isPlaying: true, playbackRate: 4 });
      reset();
      expect(s().playbackRate).toBe(1.5);
    }
  });

  it("an agent pause returns a scan to it", () => {
    useDawStore.setState({ isPlaying: true, playbackRate: 2 });
    s().applyAgentSession({
      playhead_sec: 0,
      is_playing: false,
      audition_mode: "mix",
      server_seq: 3,
      last_command_id: null,
      query: null,
      region: null,
      origin: "agent",
    } as never);
    expect(s().playbackRate).toBe(1.5);
  });

  it("stopFollow returns to it, not to 1x", () => {
    useDawStore.setState({ followingClientId: "leader", playbackRate: 1.02 });
    s().stopFollow("local");
    expect([s().followingClientId, s().playbackRate]).toEqual([null, 1.5]);
  });

  it("a pause while following leaves the leader's rate", () => {
    useDawStore.setState({
      followingClientId: "leader",
      isPlaying: true,
      playbackRate: 2,
    });
    s().setIsPlaying(false);
    expect(s().playbackRate).toBe(2);
  });

  it("a same-path hydrate keeps rate and chosen; a project switch starts at chosen", () => {
    useDawStore.setState({ playbackRate: 4, isPlaying: true });
    s().hydrate(HOST, minimalProject());
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 4]);
    useDawStore.setState({ isPlaying: false });
    s().hydrate("/tmp/other.json", minimalProject());
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 1.5]);
  });

  it("a same-path refresh that flips the frozen status re-applies the chosen speed", () => {
    const key = shareProjectKey("tok");
    rememberFrozenReview("tok", true);
    s().hydrate(key, minimalProject());
    expect(s().playbackRate).toBe(1.5);
    rememberFrozenReview("tok", false);
    s().hydrate(key, minimalProject());
    expect(s().playbackRate).toBe(1);
    rememberFrozenReview("tok", true);
    s().hydrate(key, minimalProject());
    expect(s().playbackRate).toBe(1.5);
  });

  it("a same-path refresh leaves a scan and a followed leader's rate alone", () => {
    useDawStore.setState({ playbackRate: 2, isPlaying: true });
    s().hydrate(HOST, minimalProject());
    expect(s().playbackRate).toBe(2);
    useDawStore.setState({
      isPlaying: false,
      playbackRate: 1.25,
      followingClientId: "leader",
    });
    s().hydrate(HOST, minimalProject());
    expect(s().playbackRate).toBe(1.25);
    useDawStore.setState({ followingClientId: null });
  });

  it("hydrate re-evaluates availability for each key: frozen review, live link, host", () => {
    rememberFrozenReview("tok", true);
    s().hydrate(shareProjectKey("tok"), minimalProject());
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 1.5]);
    rememberFrozenReview("tok", false);
    s().hydrate(shareProjectKey("tok2"), minimalProject());
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 1]);
    s().hydrate(HOST, minimalProject());
    expect([s().chosenPlaybackRate, s().playbackRate]).toEqual([1.5, 1.5]);
  });

  it("a live link keeps the engine at 1x through Play and Stop", () => {
    s().hydrate(shareProjectKey("tok2"), minimalProject());
    s().togglePlaying();
    expect(s().playbackRate).toBe(1);
    s().stopPlayback();
    expect(s().playbackRate).toBe(1);
    expect(s().chosenPlaybackRate).toBe(1.5);
  });
});

describe("shuttle from a chosen speed", () => {
  beforeEach(() => {
    s().setPlaybackSpeed(1.5);
    useDawStore.setState({ isPlaying: false, playheadSec: 20 });
  });

  it("L starts at the chosen speed, then scans 2x and 4x", () => {
    shuttleForward();
    expect([s().isPlaying, s().playbackRate]).toEqual([true, 1.5]);
    shuttleForward();
    expect(s().playbackRate).toBe(2);
    shuttleForward();
    expect(s().playbackRate).toBe(4);
    shuttleForward();
    expect(s().playbackRate).toBe(4);
  });

  it("with 2x chosen L goes 2x then 4x", () => {
    s().setPlaybackSpeed(2);
    shuttleForward();
    expect(s().playbackRate).toBe(2);
    shuttleForward();
    expect(s().playbackRate).toBe(4);
  });

  it("K, Space and J come back to the chosen speed, which stays chosen", () => {
    for (const back of [
      () => s().togglePlaying(),
      () => s().stopPlayback(),
      () => shuttleBack(),
    ]) {
      shuttleForward();
      shuttleForward();
      expect(s().playbackRate).toBe(2);
      back();
      expect(s().playbackRate).toBe(1.5);
      expect(s().chosenPlaybackRate).toBe(1.5);
      expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBe("1.5");
      useDawStore.setState({ isPlaying: false });
    }
  });
});

describe("effectiveChosen", () => {
  it("is 1x on a live link", () => {
    expect(
      effectiveChosen({
        projectPath: shareProjectKey("tok"),
        chosenPlaybackRate: 2,
      }),
    ).toBe(1);
  });
});
