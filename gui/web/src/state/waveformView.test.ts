import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { readWaveformViewPref } from "../utils/waveformViewPref";
import { useDawStore } from "./dawStore";

beforeEach(() => {
  localStorage.clear();
  useDawStore.getState().hydrate("/tmp/a.json", minimalProject());
});

describe("waveform view persistence", () => {
  it("persists the scale, amplitude and post-fader setters", () => {
    const st = () => useDawStore.getState();
    st().setWaveformScale("linear");
    st().nudgeWaveformAmp("in");
    st().setWaveformPostFader(true);
    const pref = readWaveformViewPref("/tmp/a.json");
    expect(pref.scale).toBe("linear");
    expect(pref.amp).toBeCloseTo(1.25);
    expect(pref.postFader).toBe(true);
  });

  it("hydrating a new project loads its own saved view (or the defaults)", () => {
    const st = () => useDawStore.getState();
    st().setWaveformScale("log");
    st().hydrate("/tmp/b.json", minimalProject());
    expect(st().waveformScale).toBe("auto");
    expect(st().waveformAmpZoom).toBe(1);
    expect(st().waveformPostFader).toBe(false);
    st().hydrate("/tmp/a.json", minimalProject());
    expect(st().waveformScale).toBe("log");
  });

  it("a same-path hydrate keeps the in-memory value", () => {
    const st = () => useDawStore.getState();
    st().setWaveformScale("log");
    st().hydrate("/tmp/a.json", minimalProject());
    expect(st().waveformScale).toBe("log");
  });

  it("writes nothing for the empty project path", () => {
    const st = () => useDawStore.getState();
    st().hydrate("", minimalProject());
    st().setWaveformScale("log");
    expect(localStorage.getItem("sharecut.waveformView")).toBeNull();
  });
});
