import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { composing, noComposer } from "../test/composerStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { dispatchComposer } from "./composer";
import { clearRegisteredCommands } from "./execute";
import { registerDawCommands } from "./register";

const at = (startSec: number) => ({ startSec, endSec: null });
const playing = () => useDawStore.getState().isPlaying;

function join(path = "share:tok") {
  useDawStore.getState().hydrate(
    path,
    minimalProject({
      tracks: [sampleTrack({ stem_is_fresh: true })],
      timeline_duration_sec: 600,
    }),
    path.startsWith("share:") ? "comment" : undefined,
    path.startsWith("share:") ? ["view", "comment"] : undefined,
  );
  useDawStore.setState({
    stage: "review",
    ...noComposer,
    isPlaying: false,
    playStartSec: null,
  });
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  join();
});

describe("dispatchComposer against the real transport", () => {
  it("plays on when the guest may no longer comment mid-compose", () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    dispatchComposer({
      type: "open",
      anchor: at(5),
      replacePin: false,
      listen: true,
    });
    expect(playing()).toBe(false);
    expect(useDawStore.getState().composer.draft?.resume).toBe(true);
    dispatchComposer({ type: "reset" });
    expect(playing()).toBe(true);
    expect(useDawStore.getState().composer).toEqual(noComposer.composer);
  });

  it("keeps the pause's promise through a second open that is not Listen", () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    dispatchComposer({
      type: "open",
      anchor: at(5),
      replacePin: false,
      listen: true,
    });
    dispatchComposer({
      type: "open",
      anchor: at(40),
      replacePin: true,
      listen: false,
    });
    expect(playing()).toBe(false);
    expect(useDawStore.getState().commentDraft).toEqual(at(40));
    dispatchComposer({ type: "postStart", id: 1 });
    dispatchComposer({ type: "postDone", id: 1 });
    expect(playing()).toBe(true);
  });

  it("plays on at Close after a second open that is not Listen", () => {
    useDawStore.setState({ isPlaying: true, playStartSec: 0 });
    dispatchComposer({
      type: "open",
      anchor: at(5),
      replacePin: false,
      listen: true,
    });
    dispatchComposer({
      type: "open",
      anchor: at(40),
      replacePin: true,
      listen: false,
    });
    dispatchComposer({ type: "close" });
    expect(playing()).toBe(true);
  });
});

describe("a held pause and a change of stage or project", () => {
  it("does not start playback when the stage changes", () => {
    join("/p");
    useDawStore.setState({ ...composing(at(5), { resume: true }) });
    useDawStore.getState().openStage("edit");
    expect(useDawStore.getState().commentDraft).toBeNull();
    expect(useDawStore.getState().composer).toEqual(noComposer.composer);
    expect(playing()).toBe(false);
  });

  it("does not start the new project playing when the project changes", () => {
    join("/p");
    useDawStore.setState({ ...composing(at(5), { resume: true }) });
    useDawStore
      .getState()
      .hydrate(
        "/q",
        minimalProject({ tracks: [sampleTrack({ stem_is_fresh: true })] }),
      );
    expect(useDawStore.getState().composer).toEqual(noComposer.composer);
    expect(playing()).toBe(false);
  });
});
