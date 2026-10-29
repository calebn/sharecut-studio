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
import { ModelsContext } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { pipelineJobSnapshot, sampleTrack } from "../../test/fixtures";
import {
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
vi.mock("../../document/applyDocumentUpdate", async (original) => ({
  ...(await original<typeof import("../../document/applyDocumentUpdate")>()),
  refreshDocumentProject: vi.fn(async () => undefined),
}));

const PATH = "/tmp/p/episode.project.json";
const models = modelsApi({ status: modelStatus(registryRows()) });
const wrapper = ({ children }: { children: ReactNode }) => (
  <ModelsContext.Provider value={models}>{children}</ModelsContext.Provider>
);

const tracks = [
  sampleTrack({ id: "maya" }),
  sampleTrack({ id: "music", role: "music" }),
  sampleTrack({ id: "joss" }),
];

function setup(
  over: { activityJob?: ReturnType<typeof pipelineJobSnapshot> | null } = {},
) {
  return renderHook(
    (props: {
      activityJob: ReturnType<typeof pipelineJobSnapshot> | null;
      isPlaying?: boolean;
    }) =>
      usePrepareSources({
        projectPath: PATH,
        tracks,
        isPlaying: props.isPlaying ?? false,
        activityJob: props.activityJob,
      }),
    {
      wrapper,
      initialProps: {
        activityJob: over.activityJob ?? null,
        isPlaying: false,
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
      rerender({ activityJob: null, isPlaying: true });
    });
    expect(result.current.playingId).toBe("maya");
    expect(useDawStore.getState().soloTracks).toEqual({ maya: true });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().playUntilSec).toBe(4);
    useDawStore.setState({ isPlaying: false });
    rerender({ activityJob: null, isPlaying: false });
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

  it("asks for the speaker model, and Try again downloads it then splits", async () => {
    vi.mocked(startSplitSpeakersJob).mockRejectedValueOnce(
      new ApiError("model needed", "model_needed", 409, {
        id: "speaker-ecapa",
        variant: null,
        label: "Speaker model",
        purpose: "speaker recognition and split",
        size: "~25 MB",
        sizeBytes: null,
        state: "missing",
      }),
    );
    const { result } = setup();
    await act(async () => result.current.actions.onSplit("maya"));
    expect(result.current.splitFailed.maya).toMatch(
      /Speaker model is not downloaded\. Try again to download it\./,
    );
    await act(async () => result.current.actions.onRetry("maya"));
    expect(models.download).toHaveBeenCalledWith(["speaker-ecapa"]);
    await waitFor(() => expect(startSplitSpeakersJob).toHaveBeenCalledTimes(2));
  });
});
