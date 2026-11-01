import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTranscriptVocabulary, startPipelineRun } from "../../api";
import { ModelsContext } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../../test/fixtures";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import {
  modelRow,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { readSoundScanStart } from "./soundScan";
import { usePrepareModel } from "./usePrepareModel";

const { config, STEPS, SAVED } = vi.hoisted(() => {
  const STEPS = [
    "ingest_tracks",
    "transcribe_tracks",
    "align_tracks",
    "fill_gate_holes",
    "clean_audio",
    "analyze_fillers_pauses",
    "apply_sound_actions",
  ];
  return {
    config: { enabled: undefined as string[] | undefined },
    STEPS,
    SAVED: STEPS.filter((id) => id !== "apply_sound_actions"),
  };
});
vi.mock("../../api", async (o) => ({
  ...(await o<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  loadTranscriptVocabulary: vi.fn(),
}));
vi.mock("../../hooks/usePipelineWorkingSet", () => ({
  usePipelineWorkingSet: () => {
    const shown = {
      ...pipelineConfig(),
      step_names: STEPS,
      enabled_steps: config.enabled ?? SAVED,
    };
    return {
      cfg: shown,
      loadError: null,
      saveError: null,
      saving: false,
      reload: vi.fn(),
      update: vi.fn(async () => true),
      fetchFresh: vi.fn(async () => shown),
    };
  },
}));
const start = vi.mocked(startPipelineRun);
const api = modelsApi({
  status: modelStatus(
    registryRows().map((r) =>
      r.id === "whisper" || r.id === "word-aligner"
        ? modelRow({ ...r, state: "installed" })
        : r,
    ),
  ),
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
);
const P = "/tmp/test/episode.sharecut";
const utt = (id: string) =>
  ({
    track_id: id,
    speaker: id,
    start_sec: 0,
    end_sec: 1,
    text: "hi",
  }) as never;
const MAYA = sampleTrack({ id: "maya", speaker: "Maya" });
const ANNEKE = sampleTrack({ id: "anneke", speaker: "Anneke" });
const PRIYA = sampleTrack({ id: "priya", speaker: "Priya" });
const project = (tracks: ReturnType<typeof sampleTrack>[], spoken: string[]) =>
  minimalProject({
    tracks,
    transcript: { utterances: spoken.map(utt) } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  config.enabled = undefined;
  start.mockResolvedValue(
    pipelineJobSnapshot({ id: "j-new", status: "running" }),
  );
  vi.mocked(loadTranscriptVocabulary).mockResolvedValue({
    show_title: null,
    prompt_limit: null,
    prompt_primer: "",
    terms: [],
    guest_names: [],
    revision: "r",
    needs_retranscription: false,
    edited_tracks: [],
  } as never);
  useDawStore.setState({
    projectPath: P,
    pipelineJob: null,
    activityJob: null,
    ingestBusy: false,
    project: project([MAYA, ANNEKE, PRIYA], ["maya", "anneke"]),
  });
});

const render = () => renderHook(() => usePrepareModel(), { wrapper });

describe("audio added to a project that already ran", () => {
  it("shows the plan and starts nothing", () => {
    const { result } = render();
    const { view } = result.current;
    expect(view.phase).toBe("new-audio");
    expect(view.readySummary).toBe("Getting ready: new audio waiting");
    expect(view.readyNote).toBe(
      "Priya’s audio is new. The other 2 tracks are reused as they are.",
    );
    expect(view.rows.map((r) => r.detail)).toEqual([
      "Priya added, 3 files",
      "Priya only · 2 kept",
      "All 3 tracks, Priya joins",
      "Priya only · 2 kept",
      "Whole episode",
    ]);
    expect(start).not.toHaveBeenCalled();
  });

  it("marks the new Source card and the session", () => {
    const { view } = render().result.current;
    const [session] = view.sessions;
    expect(session.status).toBe("new");
    expect(session.sources.map((s) => s.state)).toEqual([
      "ready",
      "ready",
      "new",
    ]);
  });

  it("makes the hand-off Process new audio, which runs the project", async () => {
    const { result } = render();
    expect(result.current.view.handoff).toEqual({ label: "Process new audio" });
    await act(async () => result.current.view.onHandoff());
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1]).toMatchObject({ fromStep: undefined });
    expect(start.mock.calls[0][1]?.skipSteps).toBeUndefined();
  });

  it("skips a row for this run only, and Include puts it back", async () => {
    const { result } = render();
    act(() => result.current.view.onRowAction("align", "skip"));
    expect(result.current.view.rows[2]).toMatchObject({
      detail: "Skipped this time",
      action: { label: "Include" },
    });
    act(() => result.current.view.onRowAction("align", "include"));
    expect(result.current.view.rows[2].detail).toBe(
      "All 3 tracks, Priya joins",
    );
    act(() => result.current.view.onRowAction("align", "skip"));
    act(() => result.current.view.onRowAction("suggest", "skip"));
    await act(async () => result.current.view.onHandoff());
    expect(start.mock.calls[0][1]?.skipSteps).toEqual(
      expect.arrayContaining(["align_tracks", "analyze_fillers_pauses"]),
    );
    expect(start.mock.calls[0][1]?.skipSteps).not.toContain(
      "transcribe_tracks",
    );
  });

  it("saves the skip nowhere: the next plan starts with every row included", async () => {
    const { result } = render();
    act(() => result.current.view.onRowAction("clean", "skip"));
    await act(async () => result.current.view.onHandoff());
    act(() =>
      useDawStore.setState({
        pipelineJob: pipelineJobSnapshot({ id: "j-new", status: "error" }),
      }),
    );
    act(() =>
      useDawStore.setState({
        pipelineJob: null,
        project: project(
          [MAYA, ANNEKE, PRIYA, sampleTrack({ id: "joss", speaker: "Joss" })],
          ["maya", "anneke"],
        ),
      }),
    );
    expect(
      result.current.view.rows.some((r) => r.detail === "Skipped this time"),
    ).toBe(false);
  });

  it("adds the sound scan row, with its cost, while the project has the scan on", () => {
    config.enabled = STEPS;
    const { view } = render().result.current;
    expect(view.rows.map((r) => r.id)).toContain("scan");
    expect(view.rows.find((r) => r.id === "scan")?.detail).toMatch(
      /^Whole episode · about /,
    );
  });

  it("goes back to the usual rows once the run covers the new audio", async () => {
    const { result } = render();
    await act(async () => result.current.view.onHandoff());
    act(() =>
      useDawStore.setState({
        pipelineJob: pipelineJobSnapshot({
          id: "j-new",
          status: "running",
          steps: [{ name: "transcribe_tracks", status: "running" }] as never,
        }),
      }),
    );
    expect(result.current.view.phase).toBe("transcribing");
    expect(result.current.view.readyNote).toBeUndefined();
    expect(result.current.view.sessions[0].status).toBe("running");
  });

  it("says what the run reused, and hands off to Review", async () => {
    const { result } = render();
    await act(async () => result.current.view.onHandoff());
    act(() =>
      useDawStore.setState({
        project: project([MAYA, ANNEKE, PRIYA], ["maya", "anneke", "priya"]),
        pipelineJob: pipelineJobSnapshot({
          id: "j-new",
          status: "ok",
          elapsed_sec: 72,
          steps: [
            {
              name: "transcribe_tracks",
              status: "ok",
              elapsed_sec: 1,
              error: null,
              reuse: { reused: 2, recomputed: 1 },
            },
            {
              name: "clean_audio",
              status: "ok",
              elapsed_sec: 1,
              error: null,
              reuse: { reused: 2, recomputed: 1 },
            },
          ] as never,
        }),
      }),
    );
    const { view } = result.current;
    expect(view.phase).toBe("done");
    expect(view.readyNote).toBe(
      "Done in 1 min 12 s. 4 of 6 results were reused, so this run did less.",
    );
    expect(view.rows[1].detail).toBe("1 new · 2 reused");
  });

  it("offers nothing new when no run reported reuse", async () => {
    const { result } = render();
    await act(async () => result.current.view.onHandoff());
    act(() =>
      useDawStore.setState({
        project: project([MAYA, ANNEKE, PRIYA], ["maya", "anneke", "priya"]),
        pipelineJob: pipelineJobSnapshot({ id: "j-new", status: "ok" }),
      }),
    );
    expect(result.current.view.readyNote).toBeUndefined();
  });

  it("offers Run everything again for a project that has results", () => {
    const { view } = render().result.current;
    expect(view.onRunAll).toBeTypeOf("function");
  });

  it("offers it for nothing when no source has results yet", () => {
    useDawStore.setState({ project: project([MAYA], []) });
    expect(render().result.current.view.onRunAll).toBeUndefined();
  });
});

describe("a project with no earlier results", () => {
  it("shows no plan for the first import", () => {
    useDawStore.setState({ project: project([MAYA, ANNEKE], []) });
    const { view } = render().result.current;
    expect(view.phase).not.toBe("new-audio");
    expect(view.handoff.label).not.toBe("Process new audio");
  });
});

describe("the sound scan switch and the person's own start choice", () => {
  it("lists the scan off, with the start choice off, in Advanced", () => {
    const { advanced } = render().result.current;
    const scan = advanced.props.groups
      .flatMap((g) => g.steps)
      .find((s) => s.id === "apply_sound_actions");
    expect(scan).toMatchObject({ enabled: false });
    expect(scan?.personal?.on).toBe(false);
  });

  it("keeps the person's own start choice on this computer, apart from the project", () => {
    const { result } = render();
    act(() =>
      result.current.advanced.props.onPersonal?.("apply_sound_actions", true),
    );
    expect(readSoundScanStart()).toBe(true);
    const scan = result.current.advanced.props.groups
      .flatMap((g) => g.steps)
      .find((s) => s.id === "apply_sound_actions");
    expect(scan?.personal?.on).toBe(true);
    expect(scan?.enabled).toBe(false);
  });

  it("ignores a personal choice for any other step", () => {
    const { result } = render();
    act(() => result.current.advanced.props.onPersonal?.("align_tracks", true));
    expect(readSoundScanStart()).toBe(false);
  });
});
