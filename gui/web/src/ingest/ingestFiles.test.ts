import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { ingestFiles } from "./ingestFiles";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    addTrackCommand: vi.fn(),
    refreshProject: vi.fn(),
    setTrackMediaCommand: vi.fn(),
    uploadMediaFile: vi.fn(),
  };
});

vi.mock("../document/applyDocumentUpdate", () => ({
  applyDocumentSnapshot: vi.fn(),
}));

const uploadMock = vi.mocked(api.uploadMediaFile);
const addTrackMock = vi.mocked(api.addTrackCommand);
const refreshMock = vi.mocked(api.refreshProject);

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
});
