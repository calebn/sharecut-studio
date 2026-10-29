import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { writeOpenIntent } from "../../utils/openIntent";
import { useLandingStage } from "./useLandingStage";

const PATH = "/tmp/test/episode.sharecut";

function open(guestMode: string | null = null) {
  useDawStore.setState({
    projectPath: PATH,
    guestMode,
    stage: "edit",
    landingSettled: false,
    project: minimalProject({ tracks: [sampleTrack()] }),
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("useLandingStage", () => {
  it("opens the stage a Home card named, once", () => {
    open();
    writeOpenIntent(PATH, { stage: "deliver" });
    renderHook(() => useLandingStage());
    expect(useDawStore.getState().stage).toBe("deliver");
    expect(sessionStorage.length).toBe(0);
  });

  it("falls back to the landing rule without an intent", () => {
    open();
    renderHook(() => useLandingStage());
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().landingSettled).toBe(true);
  });

  it("never opens a stage the role may not use", () => {
    open("view");
    writeOpenIntent(PATH, { stage: "deliver" });
    renderHook(() => useLandingStage());
    expect(useDawStore.getState().stage).toBe("review");
  });
});
