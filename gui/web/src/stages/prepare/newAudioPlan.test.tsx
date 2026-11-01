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
    "require_align_accept",
    "fill_gate_holes",
    "clean_audio",
    "compress_tracks",
    "balance_tracks",
    "analyze_fillers_pauses",
    "apply_sound_actions",
  ];
  return {
    config: {
      enabled: undefined as string[] | undefined,
      available: true,
      reload: vi.fn(),
      loadError: null as string | null,
      tighten: true,
      sounds: true,
    },
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
      config: {
        tighten: { enabled: config.tighten, apply_non_speech: config.sounds },
      },
    };
    return {
      cfg: config.available ? shown : null,
      loadError: config.loadError,
      saveError: null,
      saving: false,
      reload: config.reload,
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
  sessionStorage.clear();
  config.enabled = undefined;
  config.available = true;
  config.loadError = null;
  config.tighten = true;
  config.sounds = true;
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
      "Priya’s audio is new. The other 2 tracks keep their transcripts.",
    );
    expect(view.rows.map((r) => r.detail)).toEqual([
      "Priya added, 1 file",
      "Priya only · 2 kept",
      "All 3 tracks, Priya joins",
      "All 3 tracks",
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
      detail: "Skipped this time. Priya is not lined up with the others.",
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
      result.current.view.rows.some((r) =>
        r.detail?.startsWith("Skipped this time"),
      ),
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

  it("sizes the scan by all the audio, not the longest track", () => {
    config.enabled = STEPS;
    const { view } = render().result.current;
    // three tracks of 60 s: 180 s of audio, 5 s of scan per minute.
    expect(view.rows.find((r) => r.id === "scan")?.detail).toBe(
      "Whole episode · about 20 s",
    );
  });

  it("drops a skip whenever the plan is not on screen, not only when audio changes", () => {
    const { result } = render();
    act(() => result.current.view.onRowAction("clean", "skip"));
    expect(result.current.view.rows[3].detail).toMatch(/^Skipped/);
    act(() =>
      useDawStore.setState({
        pipelineJob: pipelineJobSnapshot({ id: "other", status: "running" }),
      }),
    );
    expect(result.current.view.phase).not.toBe("new-audio");
    act(() => useDawStore.setState({ pipelineJob: null }));
    expect(result.current.view.phase).toBe("new-audio");
    expect(result.current.view.rows[3].detail).toBe("All 3 tracks");
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
    // The New marker clears once the run has covered the audio.
    expect(view.sessions[0].status).toBe("done");
    expect(view.sessions[0].sources.map((s) => s.state)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
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

describe("the saved steps in the new-audio plan", () => {
  it.each([
    ["transcribe", "transcribe_tracks"],
    ["align", "align_tracks"],
    ["suggest", "analyze_fillers_pauses"],
  ] as const)(
    "keeps saved-disabled %s off in the plan and run",
    async (row, step) => {
      config.enabled = SAVED.filter(
        (id) => id !== step && id !== "require_align_accept",
      );
      const saved = [...config.enabled];
      const { result } = render();
      expect(result.current.view.rows.find((r) => r.id === row)).toMatchObject({
        detail: "Off in Advanced",
      });
      expect(
        result.current.view.rows.find((r) => r.id === row)?.action,
      ).toBeUndefined();
      act(() => result.current.view.onRowAction(row, "skip"));
      act(() => result.current.view.onRowAction(row, "include"));
      expect(
        result.current.view.rows.find((r) => r.id === row)?.action,
      ).toBeUndefined();
      await act(async () => result.current.view.onHandoff());
      expect(start.mock.calls[0][1]?.enabledSteps).toEqual(saved);
      expect(start.mock.calls[0][1]?.enabledSteps).not.toContain(step);
      expect(config.enabled).toEqual(saved);
    },
  );

  it("names only the enabled cleaning operations", async () => {
    config.enabled = SAVED.filter(
      (id) => id !== "clean_audio" && id !== "fill_gate_holes",
    );
    const { result } = render();
    expect(result.current.view.rows.find((r) => r.id === "clean")?.detail).toBe(
      "All 3 tracks · Compress, balance",
    );
    act(() => result.current.view.onRowAction("clean", "skip"));
    expect(result.current.view.rows.find((r) => r.id === "clean")?.detail).toBe(
      "Skipped this time. Compress, balance will not run.",
    );
    act(() => result.current.view.onRowAction("clean", "include"));
    await act(async () => result.current.view.onHandoff());
    expect(start.mock.calls[0][1]?.enabledSteps).toEqual(config.enabled);
  });

  it("does not claim alignment when only its review gate is enabled", () => {
    config.enabled = SAVED.filter((id) => id !== "align_tracks");
    const { result } = render();
    expect(result.current.view.rows.find((r) => r.id === "align")?.detail).toBe(
      "All 3 tracks · Check alignment",
    );
    act(() => result.current.view.onRowAction("align", "skip"));
    expect(result.current.view.rows.find((r) => r.id === "align")?.detail).toBe(
      "Skipped this time. Check alignment will not run.",
    );
  });

  it("respects the suggestion and sound action config gates", () => {
    config.enabled = STEPS;
    config.tighten = false;
    config.sounds = false;
    const { view } = render().result.current;
    expect(view.rows.find((r) => r.id === "suggest")?.detail).toBe(
      "Off in Advanced",
    );
    expect(view.rows.find((r) => r.id === "scan")?.action).toBeUndefined();
    expect(view.rows.some((r) => r.id === "scan")).toBe(false);
  });

  it.each([null, "Settings could not be loaded"])(
    "waits for saved settings without offering Start (%s)",
    async (error) => {
      config.available = false;
      config.loadError = error;
      const { result } = render();
      expect(result.current.view.phase).toBe("new-audio");
      expect(result.current.view.handoff.disabledReason).toBeTruthy();
      expect(
        result.current.view.rows.every((r) => r.action === undefined),
      ).toBe(true);
      expect(result.current.view.readyNote).toMatch(
        error ? /Advanced/ : /Loading saved steps/,
      );
      await act(async () => result.current.view.onHandoff());
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("updates the plan and payload together when saved steps change", async () => {
    const { result, rerender } = render();
    expect(
      result.current.view.rows.find((r) => r.id === "suggest")?.action?.run,
    ).toBe("skip");
    config.enabled = SAVED.filter((id) => id !== "analyze_fillers_pauses");
    rerender();
    expect(
      result.current.view.rows.find((r) => r.id === "suggest")?.detail,
    ).toBe("Off in Advanced");
    await act(async () => result.current.view.onHandoff());
    expect(start.mock.calls[0][1]?.enabledSteps).not.toContain(
      "analyze_fillers_pauses",
    );
  });
});

describe("the plan's sound action and recovery controls", () => {
  it("skips automatic sound actions while leaving included analysis enabled", async () => {
    config.enabled = STEPS;
    const { result } = render();
    expect(result.current.view.rows.find((r) => r.id === "scan")?.title).toBe(
      "Apply sound actions",
    );
    act(() => result.current.view.onRowAction("scan", "skip"));
    expect(result.current.view.rows.find((r) => r.id === "scan")?.detail).toBe(
      "Skipped this time. Sound actions are not applied automatically.",
    );
    await act(async () => result.current.view.onHandoff());
    expect(start.mock.calls[0][1]?.skipSteps).toContain("apply_sound_actions");
    expect(start.mock.calls[0][1]?.skipSteps).not.toContain(
      "analyze_fillers_pauses",
    );
    expect(start.mock.calls[0][1]?.config).toMatchObject({
      tighten: { enabled: true, apply_non_speech: true },
    });
  });

  it("leaves a wholly disabled cleaning group off", async () => {
    config.enabled = SAVED.filter(
      (id) =>
        ![
          "fill_gate_holes",
          "clean_audio",
          "compress_tracks",
          "balance_tracks",
        ].includes(id),
    );
    const { result } = render();
    expect(
      result.current.view.rows.find((r) => r.id === "clean"),
    ).toMatchObject({ detail: "Off in Advanced" });
    expect(
      result.current.view.rows.find((r) => r.id === "clean")?.action,
    ).toBeUndefined();
    await act(async () => result.current.view.onHandoff());
    expect(start.mock.calls[0][1]?.enabledSteps).toEqual(config.enabled);
  });

  it("retries a failed settings load through Advanced", () => {
    config.available = false;
    config.loadError = "Settings could not be loaded";
    const { result } = render();
    act(() => result.current.view.onAdvanced());
    expect(config.reload).toHaveBeenCalledOnce();
    expect(result.current.advanced.open).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});

it("does not claim a durable or confirmed On setting after a start-choice failure", () => {
  localStorage.setItem("sharecut.soundScanStartFailed", P);
  render();
  expect(useDawStore.getState().statusAnnouncement).toContain(
    "Could not confirm this browser's choice for sound actions",
  );
  expect(useDawStore.getState().statusAnnouncement).toContain(
    "reset when ShareCut restarts",
  );
  expect(useDawStore.getState().statusAnnouncement).not.toContain("It is on");
});

it("finishes real selected work without ASR, then shows a plan when more media arrives", async () => {
  config.enabled = ["ingest_tracks", "clean_audio"];
  const { result } = render();
  await act(async () => result.current.view.onHandoff());
  act(() =>
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({
        id: "j-new",
        status: "ok",
        skip_steps: STEPS.filter((name) => !config.enabled!.includes(name)),
        steps: [
          { name: "ingest_tracks", status: "ok", elapsed_sec: 1, error: null },
          {
            name: "clean_audio",
            status: "ok",
            elapsed_sec: 1,
            error: null,
            summary: "highpass on 3 dialogue tracks",
          },
        ],
      }),
    }),
  );
  expect(result.current.view.phase).toBe("done");
  expect(result.current.view.handoff.label).not.toBe("Process new audio");
  expect(result.current.view.rows[1]).toMatchObject({
    state: "queued",
    runDisposition: "omitted",
    detail: "Skipped this run",
  });
  expect(result.current.view.rows[1].action).toBeUndefined();
  act(() =>
    useDawStore.setState({
      project: project(
        [MAYA, ANNEKE, PRIYA, sampleTrack({ id: "joss", speaker: "Joss" })],
        ["maya", "anneke"],
      ),
    }),
  );
  expect(result.current.view.phase).toBe("new-audio");
  expect(result.current.view.handoff.label).toBe("Process new audio");
});

it.each(["error", "cancelled"])(
  "keeps a stopped selected run %s without attributing omitted work, then allows new media",
  async (status) => {
    config.enabled = ["ingest_tracks"];
    const { result } = render();
    await act(async () => result.current.view.onHandoff());
    act(() =>
      useDawStore.setState({
        pipelineJob: pipelineJobSnapshot({
          id: "j-new",
          status,
          error: status === "error" ? "Selected processing stopped." : null,
          skip_steps: STEPS.filter((name) => !config.enabled!.includes(name)),
          steps: [
            "ingest_tracks",
            "merge_transcript",
            "reconcile_transcript",
            "assemble_timeline",
          ].map((name) => ({
            name,
            status: "ok",
            elapsed_sec: 1,
            error: null,
          })),
        }),
      }),
    );
    expect(result.current.view.phase).toBe("failed");
    expect(result.current.view.readySummary).toBe(
      status === "error"
        ? "Getting ready: processing failed"
        : "Getting ready: processing stopped",
    );
    for (const id of ["transcribe", "align"]) {
      expect(
        result.current.view.rows.find((row) => row.id === id),
      ).toMatchObject({
        state: "queued",
        detail: "Skipped this run",
      });
    }
    act(() =>
      useDawStore.setState({
        project: project(
          [MAYA, ANNEKE, PRIYA, sampleTrack({ id: "joss", speaker: "Joss" })],
          ["maya", "anneke"],
        ),
      }),
    );
    expect(result.current.view.phase).toBe("new-audio");
    expect(result.current.view.readySummary).toBe(
      "Getting ready: new audio waiting",
    );
    expect(result.current.view.handoff.label).toBe("Process new audio");
  },
);

it("does not announce the prior stopped run while a new selected attempt starts", async () => {
  config.enabled = ["ingest_tracks"];
  const { result } = render();
  await act(async () => result.current.view.onHandoff());
  act(() =>
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({
        id: "j-new",
        status: "cancelled",
        skip_steps: STEPS.filter((name) => !config.enabled!.includes(name)),
        steps: [
          { name: "ingest_tracks", status: "ok", elapsed_sec: 1, error: null },
        ],
      }),
    }),
  );
  expect(result.current.view.readySummary).toBe(
    "Getting ready: processing stopped",
  );
  let accept!: (job: ReturnType<typeof pipelineJobSnapshot>) => void;
  start.mockReturnValueOnce(
    new Promise((resolve) => {
      accept = resolve;
    }),
  );
  await act(async () => {
    result.current.view.onRowAction("transcribe", "try-again");
  });
  expect(result.current.view.phase).toBe("transcribing");
  expect(result.current.view.readySummary).not.toContain("stopped");
  await act(async () =>
    accept(pipelineJobSnapshot({ id: "j-retry", status: "running" })),
  );
});
