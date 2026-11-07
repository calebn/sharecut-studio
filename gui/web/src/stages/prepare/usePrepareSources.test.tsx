import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  setTrackMetaCommand,
  startSplitSpeakersJob,
} from "../../api";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { ingestFiles } from "../../ingest/ingestFiles";
import { ModelsContext } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { pipelineJobSnapshot, sampleTrack } from "../../test/fixtures";
import {
  modelRow,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { parseHistoryEntryId } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { usePrepareSources } from "./usePrepareSources";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  setTrackMetaCommand: vi.fn(),
  startSplitSpeakersJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));
vi.mock("../../commands/pointer", () => ({
  runPointerCommand: vi.fn(),
  executePointerCommand: vi.fn(async () => ({ status: "ok" })),
}));
vi.mock("../../ingest/ingestFiles", () => ({ ingestFiles: vi.fn() }));
vi.mock("../../document/applyDocumentUpdate", async (original) => ({
  ...(await original<typeof import("../../document/applyDocumentUpdate")>()),
  refreshDocumentProject: vi.fn(async () => undefined),
}));

const PATH = "/tmp/p/episode.sharecut";
const MISSING = modelsApi({ status: modelStatus(registryRows()) });
const SPEAKER_IN = modelsApi({
  status: modelStatus(
    registryRows().map((row) =>
      row.id === "speaker-ecapa"
        ? modelRow({ ...row, state: "installed" })
        : row,
    ),
  ),
});
const api = { current: MISSING };
const wrapper = ({ children }: { children: ReactNode }) => (
  <ModelsContext.Provider value={api.current}>
    {children}
  </ModelsContext.Provider>
);

const tracks = [
  sampleTrack({ id: "maya" }),
  sampleTrack({ id: "music", role: "music" }),
  sampleTrack({ id: "joss" }),
];

function setup(
  over: {
    activityJob?: ReturnType<typeof pipelineJobSnapshot> | null;
    canIngest?: boolean;
  } = {},
) {
  return renderHook(
    (props: {
      activityJob: ReturnType<typeof pipelineJobSnapshot> | null;
      isPlaying?: boolean;
      projectPath?: string;
    }) =>
      usePrepareSources({
        projectPath: props.projectPath ?? PATH,
        tracks,
        isPlaying: props.isPlaying ?? false,
        activityJob: props.activityJob,
        canIngest: over.canIngest ?? true,
      }),
    {
      wrapper,
      initialProps: {
        activityJob: over.activityJob ?? null,
        isPlaying: false,
        projectPath: PATH,
      },
    },
  );
}

const RESULT = {
  split_id: "s1",
  lanes: [
    { track_id: "a", name: "Speaker 1", muted_sec: 1 },
    { track_id: "b", name: "Speaker 2", muted_sec: 1 },
  ],
  crosstalk_sec: 0,
  low_confidence_sec: 0,
  review_spans: [],
  history_head_id: "h2",
};

beforeEach(() => {
  api.current = MISSING;
  vi.clearAllMocks();
  useDawStore.setState({ projectPath: PATH, project: null, soloTracks: {} });
  vi.mocked(setTrackMetaCommand).mockResolvedValue({});
  vi.mocked(startSplitSpeakersJob).mockResolvedValue(
    pipelineJobSnapshot({ id: "split-1", kind: "split_speakers" }),
  );
  vi.mocked(followJobToOk).mockResolvedValue(
    pipelineJobSnapshot({
      id: "split-1",
      kind: "split_speakers",
      status: "ok",
      result: RESULT,
    }),
  );
});

describe("names", () => {
  it("shows a typed name at once and saves it a moment after the last key", async () => {
    vi.useFakeTimers();
    try {
      const { result } = setup();
      act(() => result.current.actions.onName("maya", "M"));
      act(() => result.current.actions.onName("maya", "Maya"));
      expect(result.current.names).toEqual({ maya: "Maya" });
      expect(setTrackMetaCommand).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(setTrackMetaCommand).toHaveBeenCalledOnce();
      expect(setTrackMetaCommand).toHaveBeenCalledWith(PATH, "maya", {
        label: "Maya",
        speaker: "Maya",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a name still waiting when Prepare closes", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = setup();
      act(() => result.current.actions.onName("maya", "Maya"));
      expect(setTrackMetaCommand).not.toHaveBeenCalled();
      unmount();
      expect(setTrackMetaCommand).toHaveBeenCalledOnce();
      expect(setTrackMetaCommand).toHaveBeenCalledWith(PATH, "maya", {
        label: "Maya",
        speaker: "Maya",
      });
      await vi.advanceTimersByTimeAsync(700);
      expect(setTrackMetaCommand).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not save an empty name", async () => {
    vi.useFakeTimers();
    try {
      const { result } = setup();
      act(() => result.current.actions.onName("maya", "  "));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(setTrackMetaCommand).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("track commands", () => {
  it("removes and replaces through the track commands, by track", () => {
    const { result } = setup();
    act(() => result.current.actions.onRemove("joss"));
    expect(runPointerCommand).toHaveBeenCalledWith("track.remove", {
      trackId: "joss",
    });
    act(() => result.current.actions.onReplace("joss"));
    expect(runPointerCommand).toHaveBeenCalledWith("media.import", {
      trackId: "joss",
    });
  });

  it("moves a voice past the next voice, over a track that is not one", () => {
    const { result } = setup();
    act(() => result.current.actions.onMove("maya", "down"));
    expect(executePointerCommand).toHaveBeenCalledWith("track.reorder", {
      trackId: "maya",
      index: 2,
    });
  });

  it("moves a dragged voice to the place of the voice it was dropped on", () => {
    const { result } = setup();
    act(() => result.current.actions.onReorder("joss", "maya"));
    expect(executePointerCommand).toHaveBeenCalledWith("track.reorder", {
      trackId: "joss",
      index: 0,
    });
  });

  it("replaces the audio of the card a file was dropped on, by track", () => {
    const { result } = setup();
    const wav = new File(["x"], "take.wav", { type: "audio/wav" });
    act(() => result.current.actions.onDropAudio?.("maya", [wav]));
    expect(ingestFiles).toHaveBeenCalledWith([wav], {
      kind: "track",
      id: "maya",
    });
  });

  it("takes one file on a card; several or none are announced and change nothing", () => {
    vi.mocked(ingestFiles).mockClear();
    const { result } = setup();
    const wav = new File(["x"], "take.wav", { type: "audio/wav" });
    const more = new File(["y"], "more.wav", { type: "audio/wav" });
    const text = new File(["z"], "notes.txt", { type: "text/plain" });
    act(() => result.current.actions.onDropAudio?.("maya", [wav, more]));
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /^Drop one file on a card/,
    );
    act(() => result.current.actions.onDropAudio?.("maya", [text]));
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Only audio files can replace a track.",
    );
    expect(ingestFiles).not.toHaveBeenCalled();
  });

  it("rejects a mixed audio and non-audio drop before replacing anything", () => {
    const { result } = setup();
    const wav = new File(["x"], "take.wav", { type: "audio/wav" });
    const notes = new File(["notes"], "notes.txt", { type: "text/plain" });
    act(() => result.current.actions.onDropAudio?.("maya", [wav, notes]));
    expect(ingestFiles).not.toHaveBeenCalled();
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /^Drop one file on a card/,
    );
  });

  it("offers no card drop when the viewer may not add audio", () => {
    const { result } = setup({ canIngest: false });
    expect(result.current.actions.onDropAudio).toBeUndefined();
  });

  it("keeps the voice count the person chose", () => {
    const { result } = setup();
    act(() => result.current.actions.onVoices("maya", 4));
    expect(result.current.chosenVoices).toEqual({ maya: 4 });
  });
});

describe("hear", () => {
  it("solos the voice for a moment and puts the solo back when playback stops", () => {
    useDawStore.setState({ soloTracks: { joss: true } });
    const { result, rerender } = setup();
    act(() => {
      result.current.actions.onHear("maya");
      rerender({ projectPath: PATH, activityJob: null, isPlaying: true });
    });
    expect(result.current.playingId).toBe("maya");
    expect(useDawStore.getState().soloTracks).toEqual({ maya: true });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playUntilSec).toBe(4);
    useDawStore.setState({ isPlaying: false });
    rerender({ projectPath: PATH, activityJob: null, isPlaying: false });
    expect(result.current.playingId).toBeNull();
    expect(useDawStore.getState().soloTracks).toEqual({ joss: true });
  });
});

describe("split", () => {
  it("splits with the chosen voice count, then refreshes and says it with Undo", async () => {
    const announce = vi.fn();
    useDawStore.setState({ announceStatus: announce });
    const { result } = setup();
    act(() => result.current.actions.onVoices("maya", 3));
    await act(async () => result.current.actions.onSplit("maya"));
    expect(startSplitSpeakersJob).toHaveBeenCalledWith(PATH, {
      trackId: "maya",
      speakerCount: 3,
      names: null,
      enrollment: null,
    });
    expect(refreshDocumentProject).toHaveBeenCalledWith(PATH);
    expect(announce).toHaveBeenCalledWith(
      expect.stringContaining("Speaker 1"),
      { undo: "h2" },
    );
    expect(result.current.splitting).toEqual({});
    expect(result.current.splitFailed).toEqual({});
  });

  it("drops the toast's Undo at the first key of a voice rename, before the rename is saved", async () => {
    useDawStore.setState({
      announceStatus: useDawStore.getInitialState().announceStatus,
      feedbackToast: null,
    });
    const { result } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    expect(useDawStore.getState().feedbackToast?.undo).toBe("h2");
    act(() => result.current.actions.onName("maya", "M"));
    expect(useDawStore.getState().feedbackToast?.undo).toBeNull();
    expect(setTrackMetaCommand).not.toHaveBeenCalled();
  });

  it("keeps an unrelated toast's Undo while a name is typed but not yet saved", () => {
    vi.useFakeTimers();
    try {
      useDawStore.setState({
        announceStatus: useDawStore.getInitialState().announceStatus,
        feedbackToast: null,
      });
      useDawStore
        .getState()
        .announceStatus("Trimmed Mira", { undo: parseHistoryEntryId("h1") });
      const { result } = setup();
      act(() => result.current.actions.onName("maya", "M"));
      expect(useDawStore.getState().feedbackToast?.undo).toBe("h1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an unrelated toast's Undo once the rename is saved", async () => {
    vi.useFakeTimers();
    try {
      useDawStore.setState({
        announceStatus: useDawStore.getInitialState().announceStatus,
        feedbackToast: null,
      });
      useDawStore
        .getState()
        .announceStatus("Trimmed Mira", { undo: parseHistoryEntryId("h1") });
      const { result } = setup();
      act(() => result.current.actions.onName("maya", "Maya"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(setTrackMetaCommand).toHaveBeenCalledOnce();
      expect(useDawStore.getState().feedbackToast?.undo).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Undo when the name is cleared and nothing is saved", async () => {
    vi.useFakeTimers();
    try {
      useDawStore.setState({
        announceStatus: useDawStore.getInitialState().announceStatus,
        feedbackToast: null,
      });
      useDawStore
        .getState()
        .announceStatus("Trimmed Mira", { undo: parseHistoryEntryId("h1") });
      const { result } = setup();
      act(() => result.current.actions.onName("maya", "  "));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(setTrackMetaCommand).not.toHaveBeenCalled();
      expect(useDawStore.getState().feedbackToast?.undo).toBe("h1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the split's Undo when another source is renamed", async () => {
    useDawStore.setState({
      announceStatus: useDawStore.getInitialState().announceStatus,
      feedbackToast: null,
    });
    const { result } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    expect(useDawStore.getState().feedbackToast?.undo).toBe("h2");
    act(() => result.current.actions.onName("joss", "J"));
    expect(useDawStore.getState().feedbackToast?.undo).toBe("h2");
  });

  it("shows the split working while it runs, with its own progress", async () => {
    let finish: (value: unknown) => void = () => undefined;
    vi.mocked(followJobToOk).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve as (value: unknown) => void;
      }) as never,
    );
    const { result, rerender } = setup();
    await act(async () => {
      result.current.actions.onSplit("maya");
    });
    await waitFor(() => expect(result.current.splitting.maya).toBeDefined());
    rerender({
      projectPath: PATH,
      isPlaying: false,
      activityJob: pipelineJobSnapshot({
        id: "split-1",
        kind: "split_speakers",
        current: 2,
        total: 8,
      }),
    });
    expect(result.current.splitting.maya).toEqual({
      detail: "Finding voices · 2 of 8",
      progress: 0.25,
    });
    await act(async () => {
      finish(
        pipelineJobSnapshot({ status: "ok", result: RESULT, id: "split-1" }),
      );
    });
    await waitFor(() => expect(result.current.splitting).toEqual({}));
  });

  it("cancels the job the card started", async () => {
    vi.mocked(followJobToOk).mockReturnValue(new Promise(() => undefined));
    vi.mocked(cancelPipelineRun).mockResolvedValue(pipelineJobSnapshot());
    const { result } = setup();
    await act(async () => {
      result.current.actions.onSplit("maya");
    });
    await waitFor(() => expect(result.current.splitting.maya).toBeDefined());
    act(() => result.current.actions.onCancelSplit("maya"));
    expect(cancelPipelineRun).toHaveBeenCalledWith("split-1");
  });

  it("fails the card with the cause, and Try again splits again", async () => {
    vi.mocked(followJobToOk).mockRejectedValueOnce(new Error("Out of memory"));
    const { result } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    expect(result.current.splitFailed).toEqual({ maya: "Out of memory" });
    await act(async () => result.current.actions.onRetry("maya"));
    expect(startSplitSpeakersJob).toHaveBeenCalledTimes(2);
    expect(result.current.splitFailed).toEqual({});
  });

  it("shows a split failure in plain words, without paths or codes", async () => {
    vi.mocked(followJobToOk).mockRejectedValueOnce(
      new Error("Failed reading /home/maya/proj/audio/take1.wav: bad_header"),
    );
    const { result } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    const shown = result.current.splitFailed.maya;
    expect(shown).toBeDefined();
    expect(shown).not.toContain("/home/maya");
    expect(shown).not.toContain("bad_header");
  });

  const SPEAKER_NEEDED = new ApiError("model needed", "model_needed", 409, {
    id: "speaker-ecapa",
    variant: null,
    label: "Speaker model",
    purpose: "speaker recognition and split",
    size: "~25 MB",
    sizeBytes: null,
    state: "missing",
  });

  it("asks for the speaker model on the card, and splits by itself when it lands", async () => {
    vi.mocked(startSplitSpeakersJob).mockRejectedValueOnce(SPEAKER_NEEDED);
    const { result, rerender } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    expect(result.current.splitNeeds.maya).toMatchObject({
      id: "speaker-ecapa",
    });
    expect(result.current.splitFailed).toEqual({});
    expect(startSplitSpeakersJob).toHaveBeenCalledOnce();
    api.current = SPEAKER_IN;
    rerender({ projectPath: PATH, activityJob: null, isPlaying: false });
    await waitFor(() => expect(startSplitSpeakersJob).toHaveBeenCalledTimes(2));
    expect(result.current.splitNeeds).toEqual({});
  });

  it("says the model is missing instead of looping when it is refused again after it landed", async () => {
    vi.mocked(startSplitSpeakersJob)
      .mockRejectedValueOnce(SPEAKER_NEEDED)
      .mockRejectedValueOnce(SPEAKER_NEEDED);
    const { result, rerender } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    api.current = SPEAKER_IN;
    rerender({ projectPath: PATH, activityJob: null, isPlaying: false });
    await waitFor(() => expect(startSplitSpeakersJob).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.splitFailed.maya).toBe(
        "Speaker model is not downloaded.",
      ),
    );
    expect(result.current.splitNeeds).toEqual({});
    await act(async () => undefined);
    expect(startSplitSpeakersJob).toHaveBeenCalledTimes(2);
  });
});

describe("split recovery queue", () => {
  const needed = new ApiError("model needed", "model_needed", 409, {
    id: "speaker-ecapa",
    variant: null,
    label: "Speaker model",
    purpose: "speaker recognition and split",
    size: "~25 MB",
    sizeBytes: null,
    state: "missing",
  });

  it("serializes waiting cards and retains each original voice count", async () => {
    const split = vi.mocked(startSplitSpeakersJob);
    split.mockRejectedValueOnce(needed).mockRejectedValueOnce(needed);
    let finish: (value: Awaited<ReturnType<typeof followJobToOk>>) => void =
      () => undefined;
    vi.mocked(followJobToOk).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = setup();
    act(() => result.current.actions.onVoices("maya", 3));
    await act(async () => result.current.actions.onSplit("maya"));
    act(() => result.current.actions.onVoices("joss", 4));
    await act(async () => result.current.actions.onSplit("joss"));
    act(() => {
      result.current.actions.onVoices("maya", 5);
      result.current.actions.onVoices("joss", 6);
    });
    api.current = SPEAKER_IN;
    rerender({ projectPath: PATH, activityJob: null, isPlaying: false });
    await waitFor(() => expect(split).toHaveBeenCalledTimes(3));
    expect(split.mock.calls[2]).toEqual([
      PATH,
      {
        trackId: "maya",
        speakerCount: 3,
        names: null,
        enrollment: null,
      },
    ]);
    expect(result.current.splitting.joss).toEqual({
      detail: "Waiting for another split",
    });
    await act(async () =>
      finish(
        pipelineJobSnapshot({
          id: "split-1",
          kind: "split_speakers",
          status: "ok",
          result: RESULT,
        }),
      ),
    );
    await waitFor(() => expect(split).toHaveBeenCalledTimes(4));
    expect(split.mock.calls[3]).toEqual([
      PATH,
      {
        trackId: "joss",
        speakerCount: 4,
        names: null,
        enrollment: null,
      },
    ]);
  });

  it.each(["path", "epoch"] as const)(
    "drops old cards when project %s and model arrival change together",
    async (change) => {
      vi.mocked(startSplitSpeakersJob).mockRejectedValueOnce(needed);
      const { result, rerender } = setup();
      await act(async () => result.current.actions.onSplit("maya"));
      await act(async () => {
        const projectPath =
          change === "path" ? "/tmp/other/episode.sharecut" : PATH;
        useDawStore.setState({
          projectPath,
          projectEpoch: useDawStore.getState().projectEpoch + 1,
        });
        api.current = SPEAKER_IN;
        rerender({ activityJob: null, isPlaying: false, projectPath });
      });
      expect(startSplitSpeakersJob).toHaveBeenCalledOnce();
      expect(result.current.splitNeeds).toEqual({});
    },
  );
});

describe("split drain ownership", () => {
  it.each(["path", "epoch"] as const)(
    "retires the old drain without stopping the new drain on a %s change",
    async (change) => {
      const needed = new ApiError("model needed", "model_needed", 409, {
        id: "speaker-ecapa",
        variant: null,
        label: "Speaker model",
        purpose: "speaker recognition and split",
        size: "~25 MB",
        sizeBytes: null,
        state: "missing",
      });
      const split = vi.mocked(startSplitSpeakersJob);
      const follow = vi.mocked(followJobToOk);
      let finishOld: (job: Awaited<ReturnType<typeof followJobToOk>>) => void =
        () => undefined;
      let finishNew: (job: Awaited<ReturnType<typeof followJobToOk>>) => void =
        () => undefined;
      follow.mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      );
      follow.mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
      split.mockRejectedValueOnce(needed);
      const { result, rerender } = setup();
      await act(async () => result.current.actions.onSplit("maya"));
      api.current = SPEAKER_IN;
      rerender({ projectPath: PATH, activityJob: null, isPlaying: false });
      await waitFor(() => expect(follow).toHaveBeenCalledTimes(1));
      const path = change === "path" ? "/tmp/new/episode.sharecut" : PATH;
      act(() => {
        useDawStore.setState({
          projectPath: path,
          projectEpoch: useDawStore.getState().projectEpoch + 1,
        });
        api.current = modelsApi({ status: modelStatus(registryRows()) });
        rerender({ projectPath: path, activityJob: null, isPlaying: false });
      });
      split.mockRejectedValueOnce(needed).mockRejectedValueOnce(needed);
      act(() => result.current.actions.onVoices("maya", 3));
      await act(async () => result.current.actions.onSplit("maya"));
      act(() => result.current.actions.onVoices("joss", 4));
      await act(async () => result.current.actions.onSplit("joss"));
      api.current = modelsApi({
        status: modelStatus(
          registryRows().map((row) =>
            row.id === "speaker-ecapa"
              ? modelRow({ ...row, state: "installed" })
              : row,
          ),
        ),
      });
      rerender({ projectPath: path, activityJob: null, isPlaying: false });
      await waitFor(() => expect(follow).toHaveBeenCalledTimes(2));
      expect(split.mock.calls[4]).toEqual([
        path,
        {
          trackId: "maya",
          speakerCount: 3,
          names: null,
          enrollment: null,
        },
      ]);
      await act(async () =>
        finishOld(
          pipelineJobSnapshot({
            id: "old",
            kind: "split_speakers",
            status: "ok",
            result: RESULT,
          }),
        ),
      );
      expect(result.current.splitting.joss).toEqual({
        detail: "Waiting for another split",
      });
      expect(result.current.splitFailed).toEqual({});
      expect(split).toHaveBeenCalledTimes(5);
      await act(async () =>
        finishNew(
          pipelineJobSnapshot({
            id: "new",
            kind: "split_speakers",
            status: "ok",
            result: RESULT,
          }),
        ),
      );
      await waitFor(() => expect(split).toHaveBeenCalledTimes(6));
      expect(split.mock.calls[5]).toEqual([
        path,
        {
          trackId: "joss",
          speakerCount: 4,
          names: null,
          enrollment: null,
        },
      ]);
      expect(refreshDocumentProject).toHaveBeenCalledWith(path);
      expect(refreshDocumentProject).toHaveBeenCalledTimes(2);
    },
  );
});
