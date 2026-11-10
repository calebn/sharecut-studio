import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { announceRefusal } from "../commands/refusal";
import { StatusLive } from "../stage/frame/StatusLive";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import type { JobStartToken } from "../state/types";
import {
  resetFeedbackRepeatForTests,
  SPOKEN_JOB_RESULT_LIMIT,
  uiProjectInitial,
} from "../state/uiSlice";
import { minimalProject, pipelineJobSnapshot } from "../test/fixtures";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { parseHistoryEntryId } from "../types/project";
import { useJobStatusAnnouncement } from "./useJobStatusAnnouncement";

function Probe() {
  useJobStatusAnnouncement();
  return null;
}

beforeEach(() => {
  resetFeedbackRepeatForTests();
  useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  useDawStore.setState({
    ...uiProjectInitial(),
    pipelineJob: null,
    activityJob: null,
    activityRunningCount: 0,
    jobFeedback: new Map(),
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
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /report a problem/,
    );
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

function beginResult(jobId: string) {
  const owner = { start: st().beginJobResultStart("bounce"), jobId };
  expect(st().bindJobResultStart(owner)).toBe(true);
  return owner;
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
    const b1 = beginResult("b1");
    mountProbe();
    act(() => {
      st().finishJobResult(b1, { kind: "verified", copy: RESULT });
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
    expect(st().jobFeedback).toEqual(new Map([]));
  });

  it("holds a job's result while its own chip is still running", () => {
    const b1 = beginResult("b1");
    mountProbe();
    act(() => {
      st().finishJobResult(b1, { kind: "verified", copy: RESULT });
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    expect(spoken()).not.toBe(RESULT);
    expect(spoken()).toContain("Mixing bounce…");
    expect(st().jobFeedback).toEqual(
      new Map([
        ["b1", { kind: "ready", outcome: { kind: "verified", copy: RESULT } }],
      ]),
    );
    act(() => {
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
  });

  it("does not re-announce the generic headline after speaking a job's result", () => {
    const b1 = beginResult("b1");
    mountProbe();
    act(() => {
      st().finishJobResult(b1, { kind: "verified", copy: RESULT });
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
    const b1 = beginResult("b1");
    mountProbe();
    act(() => {
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
      st().finishJobResult(b1, { kind: "verified", copy: RESULT });
    });
    expect(spoken()).toBe(RESULT);
    expect(st().jobFeedback).toEqual(new Map([]));
  });

  it("speaks a result whose job is no longer on the chip", () => {
    const b0 = beginResult("b0");
    mountProbe();
    act(() => {
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    act(() => {
      st().finishJobResult(b0, { kind: "verified", copy: RESULT });
    });
    expect(spoken()).toBe(RESULT);
    expect(st().jobFeedback).toEqual(new Map([]));
  });

  it("keeps both results when two jobs expect one", () => {
    const b0 = beginResult("b0");
    mountProbe();
    act(() => {
      st().expectJobResult("b1");
    });
    act(() => {
      st().finishJobResult(b0, { kind: "verified", copy: "A" });
    });
    expect(st().jobFeedback).toEqual(new Map([["b1", { kind: "known" }]]));
    expect(spoken()).toBe("A");
  });

  it("speaks two results ready in one pass together, then stays quiet", () => {
    const b1 = beginResult("b1");
    const b0 = beginResult("b0");
    mountProbe();
    act(() => {
      st().setActivityJob(bounceChip("b1", "running", "Mixing bounce…"));
    });
    act(() => {
      st().finishJobResult(b1, { kind: "verified", copy: "RESULT-B1" });
      st().finishJobResult(b0, { kind: "verified", copy: "RESULT-B0" });
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-B1. RESULT-B0");
    expect(st().jobFeedback).toEqual(new Map([]));
    act(() => {
      st().setActivityRunningCount(1);
    });
    expect(spoken()).toBe("RESULT-B1. RESULT-B0");
  });

  it("keeps every result spoken in one pass marked, not only the chip's own", () => {
    const a = beginResult("a");
    const b = beginResult("b");
    mountProbe();
    act(() => {
      st().setActivityJob(bounceChip("x", "running", "Mixing bounce…"));
    });
    act(() => {
      st().finishJobResult(a, { kind: "verified", copy: "RESULT-A" });
      st().finishJobResult(b, { kind: "verified", copy: "RESULT-B" });
    });
    expect(spoken()).toBe("RESULT-A. RESULT-B");
    act(() => {
      st().setActivityJob(bounceChip("a", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-A. RESULT-B");
  });

  it("does not let a later result for another job un-mark the chip's spoken job", () => {
    const j = beginResult("j");
    const k = beginResult("k");
    mountProbe();
    act(() => {
      st().finishJobResult(j, { kind: "verified", copy: "RESULT-J" });
      st().setActivityJob(bounceChip("j", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe("RESULT-J");
    act(() => {
      st().finishJobResult(k, { kind: "verified", copy: "RESULT-K" });
    });
    expect(spoken()).toBe("RESULT-K");
    act(() => {
      st().setActivityRunningCount(1);
    });
    expect(spoken()).toBe("RESULT-K");
  });

  it("does not speak the generic headline over a spoken result after a remount", () => {
    const b1 = beginResult("b1");
    const first = mountProbe();
    act(() => {
      st().finishJobResult(b1, { kind: "verified", copy: RESULT });
      st().setActivityJob(bounceChip("b1", "ok", "Bounce complete"));
    });
    expect(spoken()).toBe(RESULT);
    first.unmount();
    mountProbe();
    expect(spoken()).toBe(RESULT);
  });
});

describe("starting result ownership", () => {
  it("retains a remote success after the chip moves with its observed count", () => {
    mountProbe();
    let token: JobStartToken;
    act(() => {
      token = st().beginJobResultStart("bounce");
    });
    act(() => {
      st().setActivityRunningCount(3);
      st().setActivityJob(bounceChip("remote", "ok", "Remote complete"));
    });
    expect(spoken()).toBe("");
    act(() => {
      st().setActivityRunningCount(1);
      st().setActivityJob(bounceChip("next", "running", "Next bounce"));
    });
    act(() => {
      st().bindJobResultStart({ start: token, jobId: "local" });
    });
    expect(spoken()).toBe("Activity finished. Remote complete. 3 activities");
    expect(st().feedbackToast).toBeNull();
    act(() => st().releaseJobResultStart(token));
  });

  it("waits on original overlapping starts without adding later starts", () => {
    mountProbe();
    const first = st().beginJobResultStart("bounce");
    const second = st().beginJobResultStart("bounce");
    act(() =>
      st().setActivityJob(bounceChip("remote", "ok", "Remote complete")),
    );
    const later = st().beginJobResultStart("bounce");
    act(() => {
      st().setActivityRunningCount(2);
      st().releaseJobResultStart(first);
    });
    expect(spoken()).toBe("");
    act(() => {
      st().bindJobResultStart({ start: second, jobId: "local" });
    });
    expect(spoken()).toBe("Activity finished. Remote complete");
    const seq = st().statusAnnouncementSeq;
    act(() => {
      st().releaseJobResultStart(first);
      st().releaseJobResultStart(second);
      st().releaseJobResultStart(later);
    });
    expect(st().statusAnnouncementSeq).toBe(seq);
  });

  it("holds an absent kind but speaks other known kinds immediately", () => {
    mountProbe();
    const token = st().beginJobResultStart("export");
    act(() => st().setActivityJob(bounceChip("b", "ok", "Remote bounce")));
    expect(spoken()).toBe("Activity finished. Remote bounce");
    act(() =>
      st().setActivityJob({
        ...bounceChip("unknown", "ok", "Unknown complete"),
        kind: undefined,
      }),
    );
    expect(spoken()).toBe("Activity finished. Remote bounce");
    act(() => st().releaseJobResultStart(token));
    expect(spoken()).toBe("Pipeline finished. Unknown complete");
  });

  it("does not replay an unchanged terminal chip when a resource begins or ends", () => {
    mountProbe();
    act(() =>
      st().setActivityJob(bounceChip("remote", "ok", "Remote complete")),
    );
    const seq = st().statusAnnouncementSeq;
    act(() => {
      const token = st().beginJobResultStart("bounce");
      st().releaseJobResultStart(token);
    });
    expect(st().statusAnnouncementSeq).toBe(seq);
    act(() => st().setActivityRunningCount(3));
    expect(spoken()).toBe("Activity finished. Remote complete. 3 activities");
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
  });

  it("writes mixed ready copies once and puts only verified copy in the toast", () => {
    mountProbe();
    const token = st().beginJobResultStart("bounce");
    act(() =>
      st().setActivityJob(bounceChip("remote", "ok", "Remote complete")),
    );
    const seq = st().statusAnnouncementSeq;
    act(() => {
      const local = { start: token, jobId: "local" };
      st().bindJobResultStart(local);
      st().finishJobResult(local, {
        kind: "verified",
        copy: "Bounced 2 files",
      });
      st().releaseJobResultStart(token);
    });
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
    expect(spoken()).toBe(
      "Activity finished. Remote complete. Bounced 2 files",
    );
    expect(st().feedbackToast?.message).toBe("Bounced 2 files");
    expect(st().jobFeedback).toEqual(new Map([]));
  });

  it("keeps owned spoken history through generic traffic and preserves cancellation copy", () => {
    const local = beginResult("local");
    mountProbe();
    act(() => {
      st().finishJobResult(local, { kind: "verified", copy: "Verified files" });
    });
    for (let i = 0; i < 20; i++) {
      act(() =>
        st().setActivityJob(bounceChip(`remote-${i}`, "ok", "Remote complete")),
      );
    }
    expect(st().spokenJobResultIds).toEqual(["local"]);
    act(() =>
      st().setActivityJob(bounceChip("cancel", "cancelled", "Private details")),
    );
    expect(spoken()).toBe("Activity was cancelled");
    expect(st().feedbackToast?.message).toBe("Verified files");
    const seq = st().statusAnnouncementSeq;
    act(() => st().setActivityJob(bounceChip("local", "ok", "Generic local")));
    expect(st().statusAnnouncementSeq).toBe(seq);
  });
});

describe("owned outcome transactions", () => {
  const failure =
    "Export failed. The export result could not be verified. Try exporting again.";

  it.each([
    {
      status: "running",
      message: "Writing deliverables…",
      spoken: "Activity is running. Writing deliverables… 2 activities",
    },
    {
      status: "error",
      message: "Could not write audio: write_failed at /tmp/ep/export/ep.mp3",
      spoken:
        "Activity failed. Could not write audio. Try again, or report a problem from the command palette. 2 activities",
    },
  ])("keeps $status detail punctuation before the activity count", (job) => {
    render(<StatusLive />);
    act(() => {
      st().setActivityRunningCount(2);
      st().setActivityJob(
        pipelineJobSnapshot({
          id: "export-chip",
          kind: "export",
          status: job.status,
          message: job.message,
        }),
      );
    });
    expect(screen.getByRole("status").textContent).toBe(job.spoken);
  });

  it.each(["failure", "verified"] as const)(
    "delivers equal-text %s outcomes from distinct IDs once each",
    (kind) => {
      const first = beginResult("first");
      const second = beginResult("second");
      render(<StatusLive />);
      const copy = kind === "failure" ? failure : "Exported 2 files";
      const seq = st().statusAnnouncementSeq;
      act(() => {
        st().finishJobResult(first, { kind, copy });
      });
      expect(screen.getByRole("status")).toHaveTextContent(copy);
      expect(st().statusAnnouncementSeq).toBe(seq + 1);
      act(() => {
        st().finishJobResult(second, { kind, copy });
      });
      expect(screen.getByRole("status")).toHaveTextContent(copy);
      expect(st().statusAnnouncementSeq).toBe(seq + 2);
      act(() => {
        expect(st().finishJobResult(second, { kind, copy })).toBe(false);
        st().releaseJobResultStart(first.start, first);
        st().releaseJobResultStart(second.start, second);
      });
      expect(st().statusAnnouncementSeq).toBe(seq + 2);
      if (kind === "failure") expect(st().feedbackToast).toBeNull();
      else
        expect(st().feedbackToast).toMatchObject({
          message: copy,
          tone: "status",
        });
    },
  );

  it("replaces same-job progress with failure and preserves a standing toast", () => {
    const failed = beginResult("failed");
    render(<StatusLive />);
    act(() => st().announceStatus("Saved the edit"));
    const toast = st().feedbackToast;
    const seq = st().statusAnnouncementSeq;
    act(() => {
      st().setActivityJob(bounceChip("failed", "running", "Still working"));
      st().finishJobResult(failed, { kind: "failure", copy: failure });
    });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(failure);
    expect(spoken()).not.toContain("Still working");
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
    expect(st().feedbackToast).toBe(toast);
    act(() => st().releaseJobResultStart(failed.start, failed));
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
  });

  it("joins failure, released generic success and a new chip while toasting only verified copy", () => {
    const failed = beginResult("failed");
    const verified = beginResult("verified");
    const pending = st().beginJobResultStart("bounce");
    render(<StatusLive />);
    act(() => {
      st().announceStatus("Standing toast", { tone: "error" });
      st().setActivityRunningCount(3);
      st().setActivityJob(bounceChip("external", "ok", "External complete"));
    });
    const seq = st().statusAnnouncementSeq;
    act(() => {
      st().releaseJobResultStart(pending);
      st().finishJobResult(failed, { kind: "failure", copy: failure });
      st().finishJobResult(verified, {
        kind: "verified",
        copy: "Exported 2 Broadcast audio files.",
      });
      st().setActivityRunningCount(2);
      st().setActivityJob(
        pipelineJobSnapshot({
          id: "new",
          kind: "pipeline",
          status: "running",
          message: "Running transcribe_tracks",
        }),
      );
    });
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
    expect(st().feedbackToast).toMatchObject({
      message: "Exported 2 Broadcast audio files.",
      tone: "status",
    });
    expect(st().spokenJobResultIds).toEqual(["verified"]);
    act(() => {
      st().releaseJobResultStart(failed.start, failed);
      st().releaseJobResultStart(verified.start, verified);
    });
    expect(st().statusAnnouncementSeq).toBe(seq + 1);
    expect(screen.getByRole("status").textContent).toBe(
      "Pipeline is running. Running transcribe_tracks. 2 activities. " +
        "Export failed. The export result could not be verified. Try exporting again. " +
        "Exported 2 Broadcast audio files. " +
        "Activity finished. External complete. 3 activities",
    );
  });

  it("keeps Pipeline progress when a receipt failure shares the live region", () => {
    const failed = beginResult("failed");
    render(<StatusLive />);
    act(() => {
      st().finishJobResult(failed, { kind: "failure", copy: failure });
      st().setActivityRunningCount(2);
      st().setActivityJob(
        pipelineJobSnapshot({
          id: "new",
          kind: "pipeline",
          status: "running",
          message: "Running transcribe_tracks",
        }),
      );
    });
    expect(st().feedbackToast).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Pipeline is running. Running transcribe_tracks. 2 activities. " +
        "Export failed. The export result could not be verified. Try exporting again.",
    );
  });

  it("filters a failed job's internals even when verified copy shares its announcement", () => {
    const verified = beginResult("verified");
    render(<StatusLive />);
    const unsafe =
      "Could not write audio: write_failed at /tmp/ep/export/ep.mp3";
    const safe =
      "Could not write audio. Try again, or report a problem from the command palette.";
    act(() => st().announceStatus(unsafe, { tone: "error" }));
    expect(screen.getByRole("status").textContent).toBe(safe);

    act(() => {
      st().setActivityJob(bounceChip("other", "error", unsafe));
      st().finishJobResult(verified, {
        kind: "verified",
        copy: "Verified files",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(safe);
    expect(screen.getByRole("status")).not.toHaveTextContent(
      /write_failed|\/tmp\/ep\/export/,
    );
    expect(st().feedbackToast).toMatchObject({
      message: "Verified files",
      tone: "status",
    });
  });

  it("retains unverified IDs through spoken history rollover and allows ordinary errors and cancels", () => {
    const detached = beginResult("detached");
    const rejected = beginResult("rejected");
    render(<StatusLive />);
    act(() => {
      st().releaseJobResultStart(detached.start, detached);
      st().finishJobResult(rejected, { kind: "failure", copy: failure });
    });
    for (let i = 0; i < SPOKEN_JOB_RESULT_LIMIT + 1; i++) {
      act(() => {
        const next = beginResult(`verified-${i}`);
        st().finishJobResult(next, {
          kind: "verified",
          copy: "Verified files",
        });
      });
    }
    expect(st().spokenJobResultIds).toHaveLength(SPOKEN_JOB_RESULT_LIMIT);
    const seq = st().statusAnnouncementSeq;
    for (const id of ["detached", "rejected"]) {
      act(() => st().setActivityJob(bounceChip(id, "ok", "Unverified files")));
      expect(st().statusAnnouncementSeq).toBe(seq);
    }
    act(() => {
      st().setActivityRunningCount(2);
      st().setActivityJob(
        bounceChip("detached", "error", "The server did not answer"),
      );
    });
    expect(spoken()).toBe(
      "Activity failed. The server did not answer. 2 activities",
    );
    act(() =>
      st().setActivityJob(bounceChip("detached", "cancelled", "Private cause")),
    );
    expect(spoken()).toBe("Activity was cancelled. 2 activities");
    act(() =>
      st().setActivityJob(bounceChip("external", "ok", "External complete")),
    );
    expect(spoken()).toBe("Activity finished. External complete. 2 activities");
    expect(st().feedbackToast).toMatchObject({
      message: "Verified files",
      tone: "status",
    });
    const live = screen.getByRole("status");
    const afterExternal = st().statusAnnouncementSeq;
    const toast = st().feedbackToast;
    expect(st().jobFeedback.get("rejected")).toEqual({
      kind: "failure-delivered",
    });
    act(() =>
      st().setActivityJob(bounceChip("rejected", "cancelled", "Private cause")),
    );
    expect
      .soft(live.textContent)
      .toBe("Activity finished. External complete. 2 activities");
    expect.soft(st().statusAnnouncementSeq).toBe(afterExternal);
    expect(st().feedbackToast).toBe(toast);
    act(() => st().hydrate("/tmp/new-project.json", minimalProject()));
    expect(st().jobFeedback.size).toBe(0);
  });

  it("keeps Prepare's known-ID acknowledgement and settling semantics", () => {
    render(<StatusLive />);
    act(() => {
      st().expectJobResult("split");
      st().setActivityJob(
        pipelineJobSnapshot({
          id: "split",
          kind: "split_speakers",
          status: "ok",
          message: "Generic split",
        }),
      );
    });
    expect(spoken()).toBe("");
    act(() => {
      st().announceStatus("Split into 2 tracks");
      st().markJobResultsSpoken(["split"]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Split into 2 tracks");
    expect(st().jobFeedback.has("split")).toBe(false);
    expect(st().spokenJobResultIds).toEqual(["split"]);
    const seq = st().statusAnnouncementSeq;
    act(() => st().setActivityRunningCount(2));
    expect(st().statusAnnouncementSeq).toBe(seq);
    act(() => {
      st().expectJobResult("failed-split");
      st().settleJobResult("failed-split");
      st().setActivityJob(
        pipelineJobSnapshot({
          id: "failed-split",
          kind: "split_speakers",
          status: "error",
          message: "Try splitting again",
        }),
      );
    });
    expect(spoken()).toContain("Try splitting again");
    expect(st().jobFeedback.has("failed-split")).toBe(false);
    expect(st().feedbackToast?.message).toBe("Split into 2 tracks");
  });
});

describe("public feedback beside job reconciliation", () => {
  it("sanitizes public refusals and absorbs their repeated guarded announcement", () => {
    render(<StatusLive />);
    const store = useDawStore.getState;
    const raw = "Export failed: write_failed at /tmp/ep/export/output.wav";
    act(() => store().announceStatus(raw, { tone: "error", toast: false }));
    expect(screen.getByRole("status").textContent).toBe(
      "Export failed. Try again, or report a problem from the command palette.",
    );
    const seq = store().statusAnnouncementSeq;
    act(() => {
      announceRefusal({ status: "disabled", reason: raw });
    });
    expect(store().statusAnnouncementSeq).toBe(seq);
    expect(store().feedbackToast).toBeNull();
    act(() => {
      announceRefusal({ status: "disabled", reason: "Choose a format first." });
    });
    expect(screen.getByRole("status").textContent).toBe(
      "Choose a format first.",
    );
    expect(store().feedbackToast).toMatchObject({
      message: "Choose a format first.",
      tone: "error",
    });
  });

  it("keeps repeated Undo and gesture feedback eligible after a prepared job batch", () => {
    render(<StatusLive />);
    const store = useDawStore.getState;
    act(() => {
      const start = store().beginJobResultStart("export");
      const owner = { start, jobId: "before-public" };
      store().bindJobResultStart(owner);
      store().finishJobResult(owner, {
        kind: "verified",
        copy: "Files ready.",
      });
    });
    expect(screen.getByRole("status").textContent).toBe("Files ready.");
    act(() =>
      store().announceStatus("Clip removed", {
        undo: parseHistoryEntryId("h1"),
      }),
    );
    const seq = store().statusAnnouncementSeq;
    act(() =>
      store().announceStatus("Clip removed", {
        undo: parseHistoryEntryId("h2"),
      }),
    );
    expect(store().statusAnnouncementSeq).toBe(seq + 1);
    expect(store().feedbackToast).toMatchObject({
      message: "Clip removed",
      undo: "h2",
    });
    act(() => store().announceStatus("Clip armed", { gesture: true }));
    const gestureSeq = store().statusAnnouncementSeq;
    act(() => store().announceStatus("Clip armed", { gesture: true }));
    expect(store().statusAnnouncementSeq).toBe(gestureSeq + 1);
    expect(screen.getByRole("status").textContent).toBe("Clip armed");
    act(() => store().endGestureFeedback());
    expect(store().feedbackToast).toBeNull();
  });
});
