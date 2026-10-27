import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject, pipelineJobSnapshot } from "../test/fixtures";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { useJobStatusAnnouncement } from "./useJobStatusAnnouncement";

function Probe() {
  useJobStatusAnnouncement();
  return null;
}

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({
    pipelineJob: null,
    activityJob: null,
    activityRunningCount: 0,
    pendingJobResults: {},
    spokenJobResultIds: [],
    statusAnnouncement: "",
  });
});

it("speaks a failed job's message without its internals", () => {
  render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <Probe />
    </DawProvider>,
  );
  useDawStore.setState({
    pipelineJob: {
      id: "j1",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "export",
      status: "error",
      message: "Set PODCAST_MCP_FFMPEG to its bin executable.",
    } as never,
  });
  return Promise.resolve().then(() => {
    expect(useDawStore.getState().statusAnnouncement).not.toMatch(/PODCAST/);
    expect(useDawStore.getState().statusAnnouncement).toMatch(/Export/);
  });
});

it("speaks a missing model plainly, not the command its raw text carries", () => {
  render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <Probe />
    </DawProvider>,
  );
  useDawStore.setState({
    pipelineJob: {
      id: "j2",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "pipeline",
      status: "error",
      message:
        "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`",
      error_code: "model_needed",
      error_model: {
        id: "rnnoise",
        model: "rnnoise",
        label: "Noise reduction (RNNoise)",
        purpose: "noise reduction",
        size: "~0.3 MB",
        size_bytes: 297646,
        state: "missing",
      },
    } as never,
  });
  return Promise.resolve().then(() => {
    const spoken = useDawStore.getState().statusAnnouncement;
    expect(spoken).toContain("Noise reduction (RNNoise) is not downloaded.");
    expect(spoken).not.toMatch(/bootstrap|needs Noise/);
  });
});

// A job's own result copy (#704) and the chip's generic headline share one live region.
const st = () => useDawStore.getState();
const spoken = () => st().statusAnnouncement;
const RESULT = "Bounced 1 file(s) to export/bounces/";

function bounceChip(
  id: string,
  status: string,
  message: string,
): PipelineJobSnapshot {
  return pipelineJobSnapshot({
    id,
    kind: "bounce",
    label: "Bounce",
    status,
    message,
    current: null,
    total: null,
  });
}

function mountProbe() {
  return render(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <Probe />
    </DawProvider>,
  );
}

describe("job result announcements", () => {
  it("speaks a job's own result once its chip is terminal and drops it", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().announceJobResult("b1", RESULT);
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
    expect(st().pendingJobResults).toEqual({});
  });

  it("holds a job's result while its own chip is still running", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().announceJobResult("b1", RESULT);
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    expect(spoken()).not.toBe(RESULT);
    expect(spoken()).toContain("Mixing bounce…");
    expect(st().pendingJobResults).toEqual({ b1: RESULT });
    act(() => {
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
  });

  it("does not re-announce the generic headline after speaking a job's result", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().announceJobResult("b1", RESULT);
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    act(() => {
      st().setActivityRunningCount(1);
    });
    expect(spoken()).toBe(RESULT);
  });

  it("announces the generic error headline for a job that expected a result", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().setActivityJob(bounceChip("b1", "error", "Bounce failed"));
    });
    expect(spoken()).toMatch(/failed/i);
  });

  it("keeps the generic ok headline quiet until the job's own result lands", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    const running = spoken();
    expect(running).toContain("Mixing bounce…");
    act(() => {
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(running);
    expect(spoken()).not.toContain("Bounce complete");
    act(() => {
      st().announceJobResult("b1", RESULT);
    });
    expect(spoken()).toBe(RESULT);
    expect(st().pendingJobResults).toEqual({});
  });

  it("speaks a result whose job is no longer on the chip", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b0");
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    act(() => {
      st().announceJobResult("b0", RESULT);
    });
    expect(spoken()).toBe(RESULT);
    expect(st().pendingJobResults).toEqual({});
  });

  it("keeps both results when two jobs expect one", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b0");
      st().expectJobResult("b1");
    });
    act(() => {
      st().announceJobResult("b0", "A");
    });
    expect(st().pendingJobResults).toEqual({ b1: null });
    expect(spoken()).toBe("A");
  });

  it("speaks two results ready in one pass together, then stays quiet", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().expectJobResult("b0");
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    act(() => {
      st().announceJobResult("b1", "RESULT-B1");
      st().announceJobResult("b0", "RESULT-B0");
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-B1. RESULT-B0");
    expect(st().pendingJobResults).toEqual({});
    act(() => {
      st().setActivityRunningCount(1);
    });
    expect(spoken()).toBe("RESULT-B1. RESULT-B0");
  });

  it("keeps every result spoken in one pass marked, not only the chip's own", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("a");
      st().expectJobResult("b");
      st().setActivityJob(bounceChip("x", "running", "Mixing bounce…"));
    });
    act(() => {
      st().announceJobResult("a", "RESULT-A");
      st().announceJobResult("b", "RESULT-B");
    });
    expect(spoken()).toBe("RESULT-A. RESULT-B");
    act(() => {
      st().setActivityJob(bounceChip("a", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-A. RESULT-B");
  });

  it("does not let a later result for another job un-mark the chip's spoken job", () => {
    mountProbe();
    act(() => {
      st().expectJobResult("j");
      st().announceJobResult("j", "RESULT-J");
      st().setActivityJob(bounceChip("j", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-J");
    act(() => {
      st().expectJobResult("k");
      st().announceJobResult("k", "RESULT-K");
    });
    expect(spoken()).toBe("RESULT-K");
    act(() => {
      st().setActivityRunningCount(1);
    });
    expect(spoken()).toBe("RESULT-K");
  });

  it("does not speak the generic headline over a spoken result after a remount", () => {
    const first = mountProbe();
    act(() => {
      st().expectJobResult("b1");
      st().announceJobResult("b1", RESULT);
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
    first.unmount();
    mountProbe();
    expect(spoken()).toBe(RESULT);
  });
});
