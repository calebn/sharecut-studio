import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WAVEFORM_VIEW_PREF,
  readWaveformViewPref,
  WAVEFORM_VIEW_MAX_PROJECTS,
  WAVEFORM_VIEW_STORAGE_KEY,
  writeWaveformViewPref,
} from "./waveformViewPref";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readWaveformViewPref", () => {
  it("returns the default for an unknown project", () => {
    expect(readWaveformViewPref("/tmp/a.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
  });

  it("falls back to the default when storage is null, garbage or an array", () => {
    localStorage.setItem(WAVEFORM_VIEW_STORAGE_KEY, "not json");
    expect(readWaveformViewPref("/tmp/a.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
    localStorage.setItem(WAVEFORM_VIEW_STORAGE_KEY, "[1,2,3]");
    expect(readWaveformViewPref("/tmp/a.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
  });

  it("falls back to the default per invalid field", () => {
    localStorage.setItem(
      WAVEFORM_VIEW_STORAGE_KEY,
      JSON.stringify({
        "/tmp/a.json": { scale: "weird", amp: "nope", postFader: "yes" },
      }),
    );
    expect(readWaveformViewPref("/tmp/a.json")).toEqual({
      scale: "auto",
      amp: 1,
      postFader: false,
    });
  });
});

describe("writeWaveformViewPref", () => {
  it("round-trips a project", () => {
    writeWaveformViewPref("/tmp/a.json", {
      scale: "log",
      amp: 2,
      postFader: true,
    });
    expect(readWaveformViewPref("/tmp/a.json")).toEqual({
      scale: "log",
      amp: 2,
      postFader: true,
    });
  });

  it("isolates two projects", () => {
    writeWaveformViewPref("/tmp/a.json", {
      scale: "log",
      amp: 2,
      postFader: true,
    });
    writeWaveformViewPref("/tmp/b.json", {
      scale: "linear",
      amp: 4,
      postFader: false,
    });
    expect(readWaveformViewPref("/tmp/a.json").scale).toBe("log");
    expect(readWaveformViewPref("/tmp/b.json").scale).toBe("linear");
  });

  it("clamps amp on write", () => {
    writeWaveformViewPref("/tmp/a.json", {
      scale: "auto",
      amp: 0,
      postFader: false,
    });
    expect(readWaveformViewPref("/tmp/a.json").amp).toBe(1);
    writeWaveformViewPref("/tmp/a.json", {
      scale: "auto",
      amp: 99,
      postFader: false,
    });
    expect(readWaveformViewPref("/tmp/a.json").amp).toBe(16);
  });

  it("caps the map at the most-recent projects", () => {
    for (let i = 0; i < WAVEFORM_VIEW_MAX_PROJECTS + 1; i += 1) {
      writeWaveformViewPref(`/tmp/${i}.json`, {
        scale: "auto",
        amp: 1,
        postFader: false,
      });
    }
    expect(readWaveformViewPref("/tmp/0.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
    expect(readWaveformViewPref("/tmp/1.json").scale).toBe("auto");
  });

  it("re-writing an old project keeps it in the cap", () => {
    for (let i = 0; i < WAVEFORM_VIEW_MAX_PROJECTS; i += 1) {
      writeWaveformViewPref(`/tmp/${i}.json`, {
        scale: "auto",
        amp: 1,
        postFader: false,
      });
    }
    writeWaveformViewPref("/tmp/0.json", {
      scale: "log",
      amp: 1,
      postFader: false,
    });
    writeWaveformViewPref("/tmp/new.json", {
      scale: "linear",
      amp: 1,
      postFader: false,
    });
    expect(readWaveformViewPref("/tmp/0.json").scale).toBe("log");
    expect(readWaveformViewPref("/tmp/1.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
  });

  it("never writes the empty project path", () => {
    writeWaveformViewPref("", { scale: "log", amp: 2, postFader: true });
    expect(localStorage.getItem(WAVEFORM_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("falls back to the default when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readWaveformViewPref("/tmp/a.json")).toEqual(
      DEFAULT_WAVEFORM_VIEW_PREF,
    );
  });
});
