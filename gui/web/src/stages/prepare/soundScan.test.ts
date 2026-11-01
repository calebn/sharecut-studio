import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPipelineConfig, putPipelineConfig } from "../../api";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import { applySoundScanStart } from "./applySoundScanStart";
import {
  readSoundScanStart,
  SOUND_SCAN_COST,
  soundScanTime,
  writeSoundScanStart,
} from "./soundScan";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  loadPipelineConfig: vi.fn(),
  putPipelineConfig: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("the sound scan's cost", () => {
  it("is said in plain units", () => {
    expect(SOUND_SCAN_COST).toBe("about 2½ minutes for 30 minutes of audio");
  });

  it("scales to the audio, to the nearest 10 seconds", () => {
    expect(soundScanTime(30 * 60)).toBe("about 2 min 30 s");
    expect(soundScanTime(860)).toBe("about 1 min 10 s");
    expect(soundScanTime(10 * 60)).toBe("about 50 s");
    expect(soundScanTime(60 * 60)).toBe("about 5 min");
    expect(soundScanTime(0)).toBe("about 10 s");
  });
});

describe("New projects start with this", () => {
  it("is Off until the person turns it on", () => {
    expect(readSoundScanStart()).toBe(false);
    writeSoundScanStart(true);
    expect(readSoundScanStart()).toBe(true);
    writeSoundScanStart(false);
    expect(readSoundScanStart()).toBe(false);
  });

  it("reads as Off when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSoundScanStart()).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("applySoundScanStart", () => {
  const path = "/tmp/new/episode.sharecut";
  const withScan = pipelineConfig({
    enabled_steps: ["transcribe_tracks", "apply_sound_actions"],
  });

  it("turns the scan off in a new project by default", async () => {
    vi.mocked(loadPipelineConfig).mockResolvedValue(withScan);
    await applySoundScanStart(path);
    expect(putPipelineConfig).toHaveBeenCalledWith(path, {
      config: { tighten: { apply_non_speech: false } },
      enabled_steps: ["transcribe_tracks"],
    });
  });

  it("leaves it on when the person chose that", async () => {
    writeSoundScanStart(true);
    vi.mocked(loadPipelineConfig).mockResolvedValue(
      pipelineConfig({ enabled_steps: ["transcribe_tracks"] }),
    );
    await applySoundScanStart(path);
    expect(putPipelineConfig).toHaveBeenCalledWith(path, {
      config: { tighten: { apply_non_speech: true } },
      enabled_steps: ["transcribe_tracks", "apply_sound_actions"],
    });
  });

  it("never throws: the project keeps its saved default", async () => {
    vi.mocked(loadPipelineConfig).mockRejectedValue(new Error("offline"));
    await expect(applySoundScanStart(path)).resolves.toBeUndefined();
    expect(putPipelineConfig).not.toHaveBeenCalled();
  });
});
