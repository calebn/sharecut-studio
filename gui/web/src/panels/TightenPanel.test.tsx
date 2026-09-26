import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPipelineConfig,
  putPipelineConfig,
  startPipelineRun,
} from "../api";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import type { PendingEditView } from "../types/project";
import { TightenPanel } from "./TightenPanel";

vi.mock("../commands/execute", () => ({
  execute: vi.fn(async () => ({ status: "ok" })),
}));

function pipelineCfg(): PipelineConfigResponse {
  return {
    defaults: {},
    config: {
      tighten: { intensity: "medium", enabled: false, max_pause_sec: 1.2 },
    },
    enabled_steps: [],
    unattended: true,
    steps: [],
    params: [
      {
        path: "tighten.intensity",
        label: "Tighten intensity",
        description: "x",
        type: "enum",
        enum: ["light", "medium", "aggressive"],
        default: "medium",
        group: "common",
        section: "tighten",
        affects: ["analyze_fillers_pauses"],
      },
    ],
    components: {},
    step_names: [],
  };
}

function job(
  overrides: Partial<PipelineJobSnapshot> = {},
): PipelineJobSnapshot {
  return {
    id: "job1",
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: "analyze_fillers_pauses",
    kind: "pipeline",
    status: "running",
    current: null,
    total: null,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [],
    ...overrides,
  };
}

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    loadPipelineConfig: vi.fn(async () => pipelineCfg()),
    putPipelineConfig: vi.fn(
      async (_p: string, body: { config?: Record<string, unknown> }) => ({
        ...pipelineCfg(),
        config: body.config ?? {},
      }),
    ),
    startPipelineRun: vi.fn(async () => job()),
  };
});

function pending(overrides: Partial<PendingEditView> = {}): PendingEditView {
  return {
    id: "e1",
    track_id: "host",
    type: "remove",
    reason: "filler:um",
    source_start: 1,
    source_end: 1.2,
    timeline_start: 1,
    timeline_end: 1.2,
    timeline_spans: [{ start: 1, end: 1.2 }],
    mappable: true,
    crossfade_ms: 10,
    boundary_mode: null,
    cut_confidence: 0.9,
    review_required: false,
    applied: false,
    ...overrides,
  };
}

function projectWithHits() {
  return minimalProject({
    tracks: [
      {
        id: "host",
        label: "Host",
        role: "dialogue",
        speaker: "Host",
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: "Guest",
        gain_db: 0,
        muted: false,
        duration_sec: 60,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
    pending_edits: [
      pending(),
      pending({
        id: "e2",
        reason: "pause:0.9s",
        track_id: "guest",
        review_required: true,
        join_risk: {
          verdict: "review",
          label: "join_review",
          source: "reason",
        },
        source_start: 4,
        timeline_start: 4,
      }),
      pending({ id: "e3", reason: "nl:topic" }),
    ],
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "Host",
          start: 0,
          end: 2,
          text: "so um hello",
          words: [
            { text: "so", start: 0, end: 0.4 },
            { text: "um", start: 1, end: 1.2 },
            { text: "hello", start: 1.3, end: 1.8 },
          ],
        },
      ],
    },
  });
}

describe("TightenPanel", () => {
  beforeEach(() => {
    vi.mocked(execute).mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(loadPipelineConfig).mockReset();
    vi.mocked(loadPipelineConfig).mockImplementation(async () => pipelineCfg());
    vi.mocked(putPipelineConfig).mockReset();
    vi.mocked(putPipelineConfig).mockImplementation(async (_p, body) => ({
      ...pipelineCfg(),
      config: body.config ?? {},
    }));
    vi.mocked(startPipelineRun).mockReset();
    vi.mocked(startPipelineRun).mockImplementation(async () => job());
    useDawStore.getState().hydrate("/tmp/p.json", projectWithHits());
    useDawStore.setState({
      activeTab: "tighten",
      guestMode: null,
      shareCapabilities: [],
      pipelineJob: null,
      activityJob: null,
    });
  });

  afterEach(() => {
    vi.mocked(window.confirm).mockRestore();
  });

  it("changes intensity in the shared working set and finds hits for that tier", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    await screen.findByRole("option", { name: "Aggressive" });
    fireEvent.change(screen.getByLabelText("Intensity"), {
      target: { value: "aggressive" },
    });
    await waitFor(() =>
      expect(putPipelineConfig).toHaveBeenCalledWith("/tmp/p.json", {
        config: expect.objectContaining({
          tighten: expect.objectContaining({ intensity: "aggressive" }),
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() =>
      expect(startPipelineRun).toHaveBeenCalledWith(
        "/tmp/p.json",
        expect.objectContaining({
          onlyStep: "analyze_fillers_pauses",
          useWorkingSet: false,
          config: expect.objectContaining({
            tighten: expect.objectContaining({
              intensity: "aggressive",
              enabled: true,
            }),
          }),
        }),
      ),
    );
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob?.id).toBe("job1"),
    );
    expect(useDawStore.getState().activeTab).toBe("tighten");
    await expectNoA11yViolations(container);
  });

  it("disables Intensity and Find hits while a pipeline job is running", async () => {
    useDawStore.setState({ pipelineJob: job() });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    await screen.findByRole("option", { name: "Light" });
    expect(screen.getByRole("button", { name: "Find hits" })).toBeDisabled();
    expect(screen.getByLabelText("Intensity")).toBeDisabled();
  });

  it("shows an inline error when the run cannot start", async () => {
    vi.mocked(startPipelineRun).mockRejectedValue(new Error("busy"));
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    await screen.findByRole("option", { name: "Light" });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    expect(await screen.findByText("busy")).toBeTruthy();
  });

  it("lists filler/pause hits and filters by search and class", async () => {
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    expect(screen.getByRole("heading", { name: "Tighten" })).toBeTruthy();
    expect(screen.getByText("filler")).toBeTruthy();
    expect(screen.getByText("pause")).toBeTruthy();
    expect(screen.queryByText("nl:topic")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Filler" }));
    expect(screen.getByText("filler")).toBeTruthy();
    expect(screen.queryByText("pause")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Search hits"), {
      target: { value: "um" },
    });
    expect(screen.getByText("so um hello")).toBeTruthy();
    expect(screen.queryByText("pause")).toBeNull();

    await expectNoA11yViolations(container);
  });

  it("disables apply-all with aria-describedby when nothing is eligible", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const apply = screen.getByRole("button", { name: /Apply eligible/ });
    expect(apply).toBeDisabled();
    const described = apply.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described ?? "")?.textContent).toMatch(
      /eligible/i,
    );
  });

  it("shows review-required repetition and restart hits with per-hit actions", async () => {
    const project = projectWithHits();
    project.pending_edits = [
      pending({
        id: "repeat",
        reason: "repetition:word:um",
        review_required: true,
      }),
      pending({
        id: "restart",
        reason: "restart:phrase:i went",
        review_required: true,
      }),
    ];
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={project}>
        <TightenPanel />
      </DawProvider>,
    );
    expect(screen.getByText(/2 of 2 hits/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repetition" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Apply eligible/ }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(screen.getByText(/1 of 2 hits/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Apply.*Host/i }));
    expect(execute).toHaveBeenCalledWith(
      "tighten.applyHit",
      { id: "restart" },
      { skipWhen: true },
    );
    await expectNoA11yViolations(container);
  });

  it("apply-all and per-hit actions go through the command bus", () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Apply eligible/ }));
    expect(execute).toHaveBeenCalledWith(
      "tighten.applyAllSafe",
      { avoidHarsh: true, ids: ["e1", "e2"] },
      { skipWhen: true },
    );

    fireEvent.click(screen.getByRole("button", { name: /Apply.*Host/i }));
    expect(execute).toHaveBeenCalledWith(
      "tighten.applyHit",
      { id: "e1" },
      { skipWhen: true },
    );
    fireEvent.click(screen.getByRole("button", { name: /Skip.*Host/i }));
    expect(execute).toHaveBeenCalledWith(
      "tighten.skipHit",
      { id: "e1" },
      { skipWhen: true },
    );
    fireEvent.click(screen.getByRole("button", { name: /Preview.*Host/i }));
    expect(execute).toHaveBeenCalledWith(
      "tighten.previewHit",
      { id: "e1" },
      { skipWhen: true },
    );
  });

  it("disables seek and preview when a hit has no timeline bounds", () => {
    const unmapped = projectWithHits();
    unmapped.pending_edits = [
      pending({
        id: "e-unmapped",
        timeline_start: null,
        timeline_end: null,
        mappable: false,
        source_start: 9,
        source_end: 9.2,
      }),
    ];
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={unmapped}>
        <TightenPanel />
      </DawProvider>,
    );
    expect(screen.getByText("Unmapped")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Preview unmapped/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Go to unmapped/i }),
    ).toBeDisabled();
    fireEvent.click(screen.getByText("Unmapped"));
    expect(execute).not.toHaveBeenCalledWith(
      "tighten.goToHit",
      { id: "e-unmapped" },
      { skipWhen: true },
    );
  });

  function renderPanel() {
    return render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
  }

  it("disables Intensity while a save is pending and keeps the confirmed value", async () => {
    let resolvePut: (v: PipelineConfigResponse) => void = () => {};
    vi.mocked(putPipelineConfig).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePut = r;
        }),
    );
    renderPanel();
    await screen.findByRole("option", { name: "Aggressive" });
    fireEvent.change(screen.getByLabelText("Intensity"), {
      target: { value: "aggressive" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Intensity")).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Find hits" })).toBeDisabled();
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalled());
    const saved = {
      ...pipelineCfg(),
      config: {
        tighten: {
          intensity: "aggressive",
          enabled: false,
          max_pause_sec: 1.2,
        },
      },
    };
    await act(async () => {
      resolvePut(saved);
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Intensity")).not.toBeDisabled(),
    );
    expect(
      (screen.getByLabelText("Intensity") as HTMLSelectElement).value,
    ).toBe("aggressive");
  });

  it("rolls back to the last confirmed intensity when the save fails", async () => {
    vi.mocked(putPipelineConfig).mockRejectedValueOnce(
      new Error("save failed"),
    );
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.change(screen.getByLabelText("Intensity"), {
      target: { value: "light" },
    });
    expect(await screen.findByText("save failed")).toBeTruthy();
    expect(
      (screen.getByLabelText("Intensity") as HTMLSelectElement).value,
    ).toBe("medium");
  });

  it("saves intensity over a freshly loaded working set", async () => {
    vi.mocked(loadPipelineConfig)
      .mockResolvedValueOnce(pipelineCfg())
      .mockResolvedValueOnce({
        ...pipelineCfg(),
        config: {
          tighten: { intensity: "medium", enabled: false, max_pause_sec: 2.5 },
        },
      });
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.change(screen.getByLabelText("Intensity"), {
      target: { value: "light" },
    });
    await waitFor(() =>
      expect(putPipelineConfig).toHaveBeenCalledWith("/tmp/p.json", {
        config: {
          tighten: { intensity: "light", enabled: false, max_pause_sec: 2.5 },
        },
      }),
    );
  });

  it("Find hits runs on the refetched working set", async () => {
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    vi.mocked(loadPipelineConfig).mockResolvedValueOnce({
      ...pipelineCfg(),
      config: {
        tighten: { intensity: "medium", enabled: false, max_pause_sec: 3 },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() =>
      expect(startPipelineRun).toHaveBeenCalledWith(
        "/tmp/p.json",
        expect.objectContaining({
          config: expect.objectContaining({
            tighten: expect.objectContaining({
              max_pause_sec: 3,
              intensity: "medium",
              enabled: true,
            }),
          }),
        }),
      ),
    );
  });

  it("shows a config load error with Retry", async () => {
    vi.mocked(loadPipelineConfig).mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    expect(
      await screen.findByText("Could not load tighten settings: offline"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Intensity")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "Light" });
    expect(screen.queryByText(/Could not load tighten settings/)).toBeNull();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
  });

  it("asks before Find hits replaces listed hits", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("(2 now)"),
    );
    expect(startPipelineRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalled());
  });

  it("shows the Find hits job error in the panel", async () => {
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob?.id).toBe("job1"),
    );
    act(() => {
      useDawStore.setState({
        pipelineJob: job({
          status: "error",
          error: "Transcript refine is required",
        }),
      });
    });
    expect(
      await screen.findByText("Transcript refine is required"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Find hits" }),
    ).not.toBeDisabled();
  });

  it("ignores an error from a job this panel did not start", async () => {
    useDawStore.setState({
      pipelineJob: job({ id: "other", status: "error", error: "nope" }),
    });
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalled());
    expect(screen.queryByText("nope")).toBeNull();
  });

  it("does not record a Find hits job after the project changes", async () => {
    let resolveRun: (j: PipelineJobSnapshot) => void = () => {};
    vi.mocked(startPipelineRun).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveRun = r;
        }),
    );
    renderPanel();
    await screen.findByRole("option", { name: "Light" });
    fireEvent.click(screen.getByRole("button", { name: "Find hits" }));
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalled());
    act(() => {
      useDawStore.getState().hydrate("/tmp/other.json", projectWithHits());
    });
    await act(async () => {
      resolveRun(job());
    });
    expect(useDawStore.getState().pipelineJob).toBeNull();
  });
});
