import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberFrozenReview } from "../api/project";
import { matchKeymapCommands } from "../keymap/registry";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const s = () => useDawStore.getState();
const ID = "transport.cyclePlaybackSpeed";

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({ chosenPlaybackRate: 1, followingClientId: null });
  s().hydrate("/tmp/p.json", minimalProject({ tracks: [sampleTrack()] }));
});

afterEach(() => {
  rememberFrozenReview("tok", false);
  useDawStore.setState({ chosenPlaybackRate: 1, playbackRate: 1 });
  localStorage.clear();
});

describe(ID, () => {
  it("cycles the presets and wraps", async () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect((await execute(ID)).status).toBe("ok");
      seen.push(s().chosenPlaybackRate);
    }
    expect(seen).toEqual([1.25, 1.5, 2, 1]);
    expect(s().statusAnnouncement).toBe("Playback speed 1×");
  });

  it("is disabled with its reason on a live-episode link, by key and by press", async () => {
    s().hydrate(shareProjectKey("tok"), minimalProject());
    const key = await execute(ID);
    expect(key).toMatchObject({
      status: "disabled",
      reason: "Speed isn't available on live-episode links yet.",
    });
    const pointer = await execute(ID, {}, { skipWhen: true });
    expect(pointer).toMatchObject({ status: "disabled", told: true });
    expect(s().chosenPlaybackRate).toBe(1);
    expect(s().statusAnnouncement).toContain("live-episode links");
  });

  it("works on a review link that plays a published version", async () => {
    rememberFrozenReview("tok", true);
    s().hydrate(shareProjectKey("tok"), minimalProject());
    expect((await execute(ID)).status).toBe("ok");
    expect(s().chosenPlaybackRate).toBe(1.25);
  });

  it("is refused while following and says why", async () => {
    useDawStore.setState({ followingClientId: "leader" });
    const result = await execute(ID);
    expect(result).toMatchObject({ status: "disabled", told: true });
    expect(s().chosenPlaybackRate).toBe(1);
    expect(s().followingClientId).toBe("leader");
    expect(s().statusAnnouncement).toContain("follows");
  });
});

describe("the Shift+. key", () => {
  const press = (init: Partial<KeyboardEvent>) =>
    matchKeymapCommands({
      key: ".",
      code: "Period",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    }).map((cmd) => cmd.id);

  it("matches Shift+. on a US layout and on a layout that types another symbol", () => {
    expect(press({ key: ">", shiftKey: true })).toEqual([ID]);
    expect(press({ key: ":", shiftKey: true })).toEqual([ID]);
  });

  it("leaves the bare . to More", () => {
    expect(press({})).toEqual(["edit.more"]);
  });
});
