import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.mocked(loadPipelineConfig).mockClear();
    vi.mocked(putPipelineConfig).mockClear();
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

  it("disables Find hits while a pipeline job is running", async () => {
    useDawStore.setState({ pipelineJob: job() });
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={projectWithHits()}>
        <TightenPanel />
      </DawProvider>,
    );
    await screen.findByRole("option", { name: "Light" });
    expect(screen.getByRole("button", { name: "Find hits" })).toBeDisabled();
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
});
