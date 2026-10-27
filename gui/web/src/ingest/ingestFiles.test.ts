import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import { answerQuestions } from "../test/ask";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { ingestFiles, ingestIntoNewProject } from "./ingestFiles";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    addTrackCommand: vi.fn(),
    setTrackMediaCommand: vi.fn(),
    uploadMediaFile: vi.fn(),
  };
});

vi.mock("../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn(),
}));

const uploadMock = vi.mocked(api.uploadMediaFile);
const addTrackMock = vi.mocked(api.addTrackCommand);
const refreshMock = vi.mocked(refreshDocumentProject);

describe("ingestFiles", () => {
  beforeEach(() => {
    uploadMock.mockReset();
    addTrackMock.mockReset();
    refreshMock.mockReset();
    useDawStore.setState({
      projectPath: "/tmp/test/episode.project.json",
      project: minimalProject(),
      ingestBusy: false,
      statusAnnouncement: "",
    });
  });

  it("announces the failure instead of stalling on 'Importing…'", async () => {
    addTrackMock.mockResolvedValue({});
    uploadMock.mockRejectedValue(new Error("unsupported audio format"));
    const file = new File(["not audio"], "corrupt.wav", {
      type: "audio/wav",
    });

    await expect(ingestFiles([file], { kind: "new" })).resolves.toBeUndefined();

    const s = useDawStore.getState();
    expect(s.statusAnnouncement).toBe(
      "Import failed: unsupported audio format",
    );
    expect(s.ingestBusy).toBe(false);
  });

  it("announces non-Error failures without crashing", async () => {
    addTrackMock.mockResolvedValue({});
    uploadMock.mockRejectedValue("network gone");
    const file = new File(["not audio"], "corrupt.wav", {
      type: "audio/wav",
    });

    await expect(ingestFiles([file], { kind: "new" })).resolves.toBeUndefined();

    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Import failed: network gone",
    );
  });

  it("announces success and clears busy state when the import works", async () => {
    addTrackMock.mockResolvedValue({});
    uploadMock.mockResolvedValue({
      complete: true,
      rel_path: "media/good.wav",
    });
    refreshMock.mockResolvedValue(minimalProject());
    const file = new File(["RIFF...."], "good.wav", { type: "audio/wav" });

    await ingestFiles([file], { kind: "new" });

    const s = useDawStore.getState();
    expect(s.statusAnnouncement).toMatch(/^Added good/);
    expect(s.ingestBusy).toBe(false);
  });

  describe("onto a track that already has audio", () => {
    const file = new File(["RIFF...."], "take2.wav", { type: "audio/wav" });

    beforeEach(() => {
      useDawStore.setState({
        project: minimalProject({
          tracks: [sampleTrack({ id: "guest", label: "Guest" })],
        }),
      });
    });

    it("asks before replacing it, and imports nothing when kept", async () => {
      const { asked } = answerQuestions(null);
      await ingestFiles([file], { kind: "track", id: "guest" });
      expect(asked).toEqual([
        expect.objectContaining({
          kind: "confirm",
          title: "Replace the audio on the Guest track?",
          actionLabel: "Replace audio",
          danger: true,
        }),
      ]);
      expect(uploadMock).not.toHaveBeenCalled();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    });

    it("replaces it once confirmed", async () => {
      answerQuestions(true);
      uploadMock.mockResolvedValue({
        complete: true,
        rel_path: "media/take2.wav",
      });
      refreshMock.mockResolvedValue(minimalProject());
      await ingestFiles([file], { kind: "track", id: "guest" });
      expect(uploadMock).toHaveBeenCalledOnce();
      expect(useDawStore.getState().statusAnnouncement).toMatch(
        /^Replaced Guest/,
      );
    });
  });
});

describe("ingestIntoNewProject", () => {
  const PATH = "/ws/new/episode.project.json";
  const setMediaMock = vi.mocked(api.setTrackMediaCommand);

  beforeEach(() => {
    uploadMock.mockReset();
    addTrackMock.mockReset();
    setMediaMock.mockReset();
    addTrackMock.mockResolvedValue({});
    setMediaMock.mockResolvedValue({});
    uploadMock.mockImplementation(async (_path, file) => ({
      complete: true,
      rel_path: `raw/${file.name}`,
    }));
  });

  it("adds one track per file to a project the store has not opened", async () => {
    useDawStore.setState({ projectPath: "", project: null });
    const files = [new File(["a"], "Rosa.wav"), new File(["b"], "Maya.wav")];
    await ingestIntoNewProject(PATH, files);
    expect(addTrackMock).toHaveBeenCalledWith(PATH, {
      track_id: "rosa",
      label: "Rosa",
    });
    expect(addTrackMock).toHaveBeenCalledWith(PATH, {
      track_id: "maya",
      label: "Maya",
    });
    expect(setMediaMock).toHaveBeenCalledWith(PATH, "rosa", "raw/Rosa.wav");
    expect(setMediaMock).toHaveBeenCalledWith(PATH, "maya", "raw/Maya.wav");
  });

  it("numbers two files with the same name apart", async () => {
    await ingestIntoNewProject(PATH, [
      new File(["a"], "take.wav"),
      new File(["b"], "take.wav"),
    ]);
    expect(addTrackMock.mock.calls.map((c) => c[1]?.track_id)).toEqual([
      "take",
      "take_2",
    ]);
  });

  it("throws the first failure so Home can say so", async () => {
    uploadMock.mockRejectedValue(new Error("Disk full."));
    await expect(
      ingestIntoNewProject(PATH, [new File(["a"], "a.wav")]),
    ).rejects.toThrow("Disk full.");
  });
});
