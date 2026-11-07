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
    vi.mocked(api.setTrackMediaCommand).mockReset();
    refreshMock.mockReset();
    useDawStore.setState({
      projectPath: "/tmp/test/episode.sharecut",
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

  it("refreshes the project after a failed import so files that landed show", async () => {
    addTrackMock.mockResolvedValue({});
    uploadMock.mockRejectedValue(new Error("unsupported audio format"));
    refreshMock.mockResolvedValue(minimalProject());
    const file = new File(["not audio"], "corrupt.wav", { type: "audio/wav" });

    await ingestFiles([file], { kind: "new" });

    expect(refreshMock).toHaveBeenCalledWith("/tmp/test/episode.sharecut");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Import failed: unsupported audio format",
    );
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

  it("stays busy until the last of two overlapping imports settles", async () => {
    addTrackMock.mockResolvedValue({});
    let release: () => void = () => undefined;
    uploadMock.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({ complete: true, rel_path: "media/a.wav" })),
        ),
    );
    uploadMock.mockResolvedValueOnce({
      complete: true,
      rel_path: "media/b.wav",
    });
    refreshMock.mockResolvedValue(minimalProject());
    const slow = ingestFiles([new File(["a"], "a.wav")], { kind: "new" });
    await ingestFiles([new File(["b"], "b.wav")], { kind: "new" });
    expect(useDawStore.getState().ingestBusy).toBe(true);
    expect(useDawStore.getState().ingestFileCount).toBe(1);
    release();
    await slow;
    expect(useDawStore.getState().ingestBusy).toBe(false);
    expect(useDawStore.getState().ingestFileCount).toBe(0);
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

    it("replaces it without asking, and offers Undo for the swap", async () => {
      const { asked } = answerQuestions(true);
      uploadMock.mockResolvedValue({
        complete: true,
        rel_path: "media/take2.wav",
      });
      refreshMock.mockResolvedValue(minimalProject());
      vi.mocked(api.setTrackMediaCommand).mockResolvedValueOnce({
        history_head_id: "e-swap",
      });
      await ingestFiles([file], { kind: "track", id: "guest" });
      expect(asked).toEqual([]);
      expect(uploadMock).toHaveBeenCalledOnce();
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "e-swap",
      });
      expect(useDawStore.getState().statusAnnouncement).toMatch(
        /^Replaced Guest/,
      );
    });

    it("keeps same-track replacements in drop order when the later upload is ready first", async () => {
      let finishFirst!: (
        value: Awaited<ReturnType<typeof api.uploadMediaFile>>,
      ) => void;
      let finishSecond!: (
        value: Awaited<ReturnType<typeof api.uploadMediaFile>>,
      ) => void;
      const firstUpload = new Promise<
        Awaited<ReturnType<typeof api.uploadMediaFile>>
      >((resolve) => {
        finishFirst = resolve;
      });
      const secondUpload = new Promise<
        Awaited<ReturnType<typeof api.uploadMediaFile>>
      >((resolve) => {
        finishSecond = resolve;
      });
      uploadMock
        .mockImplementationOnce(() => firstUpload)
        .mockImplementationOnce(() => secondUpload);
      const applied: string[] = [];
      vi.mocked(api.setTrackMediaCommand).mockImplementation(
        async (_path, _id, media) => {
          applied.push(media);
          return {
            history_head_id:
              media === "media/earlier.wav" ? "e-earlier" : "e-later",
          };
        },
      );
      refreshMock.mockResolvedValue(minimalProject());
      const first = ingestFiles([new File(["a"], "earlier.wav")], {
        kind: "track",
        id: "guest",
      });
      const second = ingestFiles([new File(["b"], "later.wav")], {
        kind: "track",
        id: "guest",
      });
      finishSecond({ complete: true, rel_path: "media/later.wav" });
      await secondUpload;
      await Promise.resolve();
      const appliedBeforeFirstFinished = [...applied];
      const busyWhileWaiting = useDawStore.getState().ingestBusy;
      finishFirst({ complete: true, rel_path: "media/earlier.wav" });
      await Promise.all([first, second]);
      expect(appliedBeforeFirstFinished).toEqual([]);
      expect(busyWhileWaiting).toBe(true);
      expect(applied).toEqual(["media/earlier.wav", "media/later.wav"]);
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "e-later",
      });
      expect(useDawStore.getState().ingestBusy).toBe(false);
    });

    it("waits for the earlier refresh and result before starting the next replacement", async () => {
      let releaseRefresh!: (project: ReturnType<typeof minimalProject>) => void;
      let refreshStarted!: () => void;
      const firstRefreshStarted = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      refreshMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseRefresh = resolve;
              refreshStarted();
            }),
        )
        .mockResolvedValue(minimalProject());
      uploadMock
        .mockResolvedValueOnce({ complete: true, rel_path: "media/first.wav" })
        .mockResolvedValueOnce({
          complete: true,
          rel_path: "media/second.wav",
        });
      const events: string[] = [];
      const undoHeads: Array<string | null | undefined> = [];
      const announce = useDawStore.getState().announceStatus;
      useDawStore.setState({
        announceStatus: (message, options) => {
          events.push(message);
          if (options?.undo) undoHeads.push(options.undo);
          announce(message, options);
        },
      });
      vi.mocked(api.setTrackMediaCommand)
        .mockResolvedValueOnce({ history_head_id: "e-first" })
        .mockResolvedValueOnce({ history_head_id: "e-second" });

      const first = ingestFiles([new File(["a"], "first.wav")], {
        kind: "track",
        id: "guest",
      });
      const second = ingestFiles([new File(["b"], "second.wav")], {
        kind: "track",
        id: "guest",
      });
      await firstRefreshStarted;
      const uploadsWhileRefreshHeld = uploadMock.mock.calls.length;
      const countWhileRefreshHeld = useDawStore.getState().ingestFileCount;

      releaseRefresh(minimalProject());
      await Promise.all([first, second]);

      expect(uploadsWhileRefreshHeld).toBe(1);
      expect(countWhileRefreshHeld).toBe(2);
      const results = events.filter((message) =>
        message.startsWith("Replaced Guest"),
      );
      expect(results).toHaveLength(2);
      expect(undoHeads).toEqual(["e-first", "e-second"]);
      expect(api.setTrackMediaCommand).toHaveBeenNthCalledWith(
        1,
        "/tmp/test/episode.sharecut",
        "guest",
        "media/first.wav",
      );
      expect(api.setTrackMediaCommand).toHaveBeenNthCalledWith(
        2,
        "/tmp/test/episode.sharecut",
        "guest",
        "media/second.wav",
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "e-second",
      });
      expect(useDawStore.getState().ingestBusy).toBe(false);
    });

    it("continues after upload and recovery refresh failures through a third replacement", async () => {
      const announcements: string[] = [];
      const announce = useDawStore.getState().announceStatus;
      useDawStore.setState({
        announceStatus: (message, options) => {
          announcements.push(message);
          announce(message, options);
        },
      });
      uploadMock
        .mockRejectedValueOnce(new Error("first upload failed"))
        .mockResolvedValueOnce({ complete: true, rel_path: "media/second.wav" })
        .mockResolvedValueOnce({ complete: true, rel_path: "media/third.wav" });
      refreshMock
        .mockRejectedValueOnce(new Error("recovery refresh failed"))
        .mockResolvedValue(minimalProject());
      vi.mocked(api.setTrackMediaCommand)
        .mockResolvedValueOnce({ history_head_id: "e-second" })
        .mockResolvedValueOnce({ history_head_id: "e-third" });

      await Promise.all([
        ingestFiles([new File(["a"], "first.wav")], {
          kind: "track",
          id: "guest",
        }),
        ingestFiles([new File(["b"], "second.wav")], {
          kind: "track",
          id: "guest",
        }),
      ]);
      await ingestFiles([new File(["c"], "third.wav")], {
        kind: "track",
        id: "guest",
      });

      expect(useDawStore.getState().statusAnnouncement).toMatch(
        /^Replaced Guest/,
      );
      expect(announcements).toContain("Import failed: first upload failed");
      expect(api.setTrackMediaCommand).toHaveBeenNthCalledWith(
        1,
        "/tmp/test/episode.sharecut",
        "guest",
        "media/second.wav",
      );
      expect(api.setTrackMediaCommand).toHaveBeenNthCalledWith(
        2,
        "/tmp/test/episode.sharecut",
        "guest",
        "media/third.wav",
      );
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "e-third",
      });
      expect(useDawStore.getState().ingestBusy).toBe(false);
      expect(useDawStore.getState().ingestFileCount).toBe(0);
    });

    it("keeps a held target replacement independent from other targets and new imports", async () => {
      let releaseGuest!: (
        value: Awaited<ReturnType<typeof api.uploadMediaFile>>,
      ) => void;
      uploadMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseGuest = resolve;
            }),
        )
        .mockImplementation(async (_path, file) => ({
          complete: true,
          rel_path: `media/${file.name}`,
        }));
      addTrackMock.mockResolvedValue({});
      refreshMock.mockResolvedValue(minimalProject());
      const guest = ingestFiles([new File(["a"], "guest.wav")], {
        kind: "track",
        id: "guest",
      });
      const host = ingestFiles([new File(["b"], "host.wav")], {
        kind: "track",
        id: "host",
      });
      const added = ingestFiles([new File(["c"], "new.wav")], {
        kind: "new",
      });
      await Promise.all([host, added]);
      const guestStillBusy = useDawStore.getState().ingestBusy;
      const countWhileGuestHeld = useDawStore.getState().ingestFileCount;
      releaseGuest({ complete: true, rel_path: "media/guest.wav" });
      await guest;

      expect(guestStillBusy).toBe(true);
      expect(countWhileGuestHeld).toBe(1);
      expect(api.setTrackMediaCommand).toHaveBeenCalledWith(
        "/tmp/test/episode.sharecut",
        "host",
        "media/host.wav",
      );
      expect(addTrackMock).toHaveBeenCalledWith("/tmp/test/episode.sharecut", {
        track_id: "new",
        label: "new",
      });
      expect(api.setTrackMediaCommand).toHaveBeenCalledWith(
        "/tmp/test/episode.sharecut",
        "guest",
        "media/guest.wav",
      );
      expect(useDawStore.getState().ingestBusy).toBe(false);
    });

    it("changes nothing when the project switched during the upload", async () => {
      vi.mocked(api.setTrackMediaCommand).mockClear();
      uploadMock.mockImplementation(async () => {
        useDawStore.setState({ projectPath: "/tmp/other/episode.sharecut" });
        return { complete: true, rel_path: "media/take2.wav" };
      });
      await ingestFiles([file], { kind: "track", id: "guest" });
      expect(api.setTrackMediaCommand).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it("offers Undo for the swap when several files are dropped", async () => {
      uploadMock.mockResolvedValue({
        complete: true,
        rel_path: "media/take.wav",
      });
      refreshMock.mockResolvedValue(minimalProject());
      vi.mocked(api.setTrackMediaCommand)
        .mockResolvedValueOnce({ history_head_id: "e-extra" })
        .mockResolvedValueOnce({ history_head_id: "e-swap" });
      await ingestFiles([file, new File(["b"], "Extra.wav")], {
        kind: "track",
        id: "guest",
      });
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        undo: "e-swap",
      });
      expect(useDawStore.getState().statusAnnouncement).toMatch(
        /^Replaced Guest/,
      );
    });
  });
});

describe("ingestIntoNewProject", () => {
  const PATH = "/ws/new/episode.sharecut";
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

  it("stops at the first failure and says how many files were added", async () => {
    uploadMock.mockImplementation(async (_path, file) => {
      if (file.name === "b.wav") throw new Error("Disk full.");
      return { complete: true, rel_path: `raw/${file.name}` };
    });
    const result = await ingestIntoNewProject(PATH, [
      new File(["a"], "a.wav"),
      new File(["b"], "b.wav"),
      new File(["c"], "c.wav"),
    ]);
    expect(result.added).toBe(1);
    expect(result.failed).toEqual(new Error("Disk full."));
    expect(addTrackMock).toHaveBeenCalledTimes(2);
  });

  it("reports every file added when none fails", async () => {
    const result = await ingestIntoNewProject(PATH, [new File(["a"], "a.wav")]);
    expect(result).toEqual({ added: 1 });
  });
});
