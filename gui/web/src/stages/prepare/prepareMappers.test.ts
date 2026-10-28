import { describe, expect, it } from "vitest";
import { pipelineJobSnapshot, sampleTrack } from "../../test/fixtures";
import {
  applyCleanup,
  cleanupFromConfig,
  handoffProps,
  isWorking,
  type ModelAsk,
  prepareHandoff,
  preparePhase,
  prepareSessions,
  type ReadyInput,
  readyRows,
  readySummary,
  rowOutcome,
  STILL_GETTING_READY,
  sourceTracks,
  transcriptIndex,
  vocabularyChips,
  vocabularyFromChips,
} from "./prepareMappers";

function step(name: string, status: string, extra = {}) {
  return { name, status, elapsed_sec: 1, error: null, ...extra };
}

const base: ReadyInput = {
  sourceCount: 3,
  ingestBusy: false,
  transcribed: false,
  starting: false,
  job: null,
  pendingSuggestions: 0,
  model: null,
  approximateTiming: null,
  keepFixes: null,
};

const sessionBase = {
  transcribed: new Set<string>(),
  voicesIn: new Map<string, number>(),
  mayManage: true,
  ingestBusy: false,
  playingId: null,
  chosenVoices: {},
  splitting: {},
  splitFailed: {},
  job: null,
};

describe("sourceTracks", () => {
  it("keeps the dialogue tracks, in project order", () => {
    const tracks = [
      sampleTrack({ id: "a" }),
      sampleTrack({ id: "m", role: "music" }),
      sampleTrack({ id: "b" }),
    ];
    expect(sourceTracks(tracks).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("transcriptIndex", () => {
  it("names the tracks that have words and how many voices each holds", () => {
    const { transcribed, voices } = transcriptIndex([
      { track_id: "a", speaker: "Maya" },
      { track_id: "a", speaker: "Joss" },
      { track_id: "b", speaker: "Anneke" },
    ]);
    expect([...transcribed]).toEqual(["a", "b"]);
    expect(voices.get("a")).toBe(2);
    expect(transcriptIndex(undefined).transcribed.size).toBe(0);
  });
});

describe("prepareSessions", () => {
  const tracks = [
    sampleTrack({ id: "maya", speaker: "Maya", duration_sec: 860 }),
    sampleTrack({ id: "t2", speaker: null, duration_sec: 120 }),
  ];

  it("is empty with no dialogue track", () => {
    expect(
      prepareSessions({
        ...sessionBase,
        tracks: [sampleTrack({ role: "music" })],
      }),
    ).toEqual([]);
  });

  it("groups the sources in one session with its numbers", () => {
    const [session] = prepareSessions({ ...sessionBase, tracks });
    expect(session).toMatchObject({
      title: "Session 1",
      people: 1,
      takes: 2,
      duration: "14:20",
      targetLocked: true,
      status: "idle",
    });
    expect(session.sources.map((s) => [s.id, s.state, s.name])).toEqual([
      ["maya", "ready", "Maya"],
      ["t2", "needs-name", ""],
    ]);
    expect(session.sources[0]).toMatchObject({
      fileName: "maya.wav",
      audioTime: "14:20 of audio",
    });
  });

  it("shows upload and probe states while an import runs", () => {
    const [session] = prepareSessions({
      ...sessionBase,
      ingestBusy: true,
      tracks: [
        sampleTrack({ id: "u", media_path: null, duration_sec: null }),
        sampleTrack({ id: "p", duration_sec: null }),
        sampleTrack({ id: "r" }),
      ],
    });
    expect(session.sources.map((s) => s.state)).toEqual([
      "uploading",
      "probing",
      "needs-name",
    ]);
  });

  it("fails a track that has no audio once the import is over", () => {
    const [session] = prepareSessions({
      ...sessionBase,
      tracks: [sampleTrack({ media_path: null }), sampleTrack({ id: "b" })],
    });
    expect(session.sources[0]).toMatchObject({
      state: "failed",
      cause: "This track has no audio yet.",
    });
  });

  it("offers the split prompt on the only file, or on a file with several voices", () => {
    const only = prepareSessions({
      ...sessionBase,
      tracks: [sampleTrack({ id: "solo", speaker: "Maya" })],
    })[0].sources[0];
    expect(only).toMatchObject({ state: "split-prompt", canSplit: true });
    const many = prepareSessions({
      ...sessionBase,
      voicesIn: new Map([["a", 3]]),
      tracks: [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })],
    })[0].sources;
    expect(many.map((s) => s.canSplit)).toEqual([true, false]);
  });

  it("shows the prompt on the file the person asked to split", () => {
    const sources = prepareSessions({
      ...sessionBase,
      focusTrackId: "b",
      tracks: [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })],
    })[0].sources;
    expect(sources.map((s) => s.state)).toEqual(["needs-name", "split-prompt"]);
    const lane = prepareSessions({
      ...sessionBase,
      focusTrackId: "a",
      tracks: [sampleTrack({ id: "a", speaker_split_id: "s1" })],
    })[0].sources[0];
    expect(lane.canSplit).toBe(false);
  });

  it("does not offer the split to a guest, or on a lane that is already split", () => {
    const guest = prepareSessions({
      ...sessionBase,
      mayManage: false,
      tracks: [sampleTrack()],
    })[0].sources[0];
    expect(guest.canSplit).toBe(false);
    const lane = prepareSessions({
      ...sessionBase,
      tracks: [sampleTrack({ speaker_split_id: "s1" })],
    })[0].sources[0];
    expect(lane.canSplit).toBe(false);
  });

  it("follows a split in flight and its failure, and the chosen voice count", () => {
    const tracks2 = [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })];
    const [session] = prepareSessions({
      ...sessionBase,
      tracks: tracks2,
      splitting: { a: { detail: "Finding voices", progress: 0.5 } },
      splitFailed: { b: "Could not tell the voices apart." },
      chosenVoices: { a: 4 },
      playingId: "b",
    });
    expect(session.sources[0]).toMatchObject({
      state: "splitting",
      splitDetail: "Finding voices",
      progress: 0.5,
      voices: 4,
    });
    expect(session.sources[1]).toMatchObject({
      state: "failed",
      cause: "Could not tell the voices apart.",
      playing: true,
    });
  });

  it("reports the job on the session", () => {
    const running = prepareSessions({
      ...sessionBase,
      tracks,
      job: pipelineJobSnapshot({ status: "running", current: 1, total: 4 }),
    })[0];
    expect(running).toMatchObject({ status: "running", progress: 0.25 });
    const failed = prepareSessions({
      ...sessionBase,
      tracks,
      job: pipelineJobSnapshot({ status: "error" }),
    })[0];
    expect(failed.status).toBe("failed");
    const done = prepareSessions({
      ...sessionBase,
      tracks,
      transcribed: new Set(["maya", "t2"]),
    })[0];
    expect(done.status).toBe("done");
  });
});

describe("rowOutcome", () => {
  it("is null without a job", () => {
    expect(rowOutcome(null, "align")).toBeNull();
  });

  it("reads a row from the steps that belong to it", () => {
    const job = pipelineJobSnapshot({
      status: "running",
      steps: [
        step("ingest_tracks", "ok"),
        step("transcribe_tracks", "ok"),
        step("align_tracks", "running"),
      ],
    });
    expect(rowOutcome(job, "add")?.state).toBe("done");
    expect(rowOutcome(job, "transcribe")?.state).toBe("done");
    expect(rowOutcome(job, "align")?.state).toBe("running");
    expect(rowOutcome(job, "clean")?.state).toBe("queued");
  });

  it("fails the row whose step failed, with the step's error", () => {
    const job = pipelineJobSnapshot({
      status: "error",
      steps: [step("clean_audio", "error", { error: "Out of memory" })],
    });
    expect(rowOutcome(job, "clean")).toEqual({
      state: "failed",
      error: "Out of memory",
    });
  });

  it("marks every row done when the job is, even a skipped one", () => {
    const job = pipelineJobSnapshot({
      status: "ok",
      steps: [step("ingest_tracks", "ok")],
    });
    expect(rowOutcome(job, "suggest")?.state).toBe("done");
  });

  it("fails the first row that never started when the job stopped early", () => {
    const stopped = pipelineJobSnapshot({
      status: "cancelled",
      steps: [step("ingest_tracks", "ok")],
    });
    expect(rowOutcome(stopped, "transcribe")).toEqual({
      state: "failed",
      error: "Stopped before this step.",
    });
  });
});

describe("readyRows", () => {
  it("has no rows without sources", () => {
    expect(readyRows({ ...base, sourceCount: 0 })).toEqual([]);
  });

  it("queues the work after an import and offers Start when nothing is going", () => {
    const rows = readyRows(base);
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["add", "done"],
      ["transcribe", "queued"],
      ["align", "queued"],
      ["clean", "queued"],
      ["suggest", "queued"],
    ]);
    expect(rows[1].action).toEqual({ label: "Start", run: "try-again" });
    expect(readyRows({ ...base, starting: true })[1].action).toBeUndefined();
  });

  it("does not call new audio done because an earlier run finished", () => {
    const finished = pipelineJobSnapshot({
      status: "ok",
      steps: [step("transcribe", "ok"), step("analyze", "ok")],
    });
    const rows = readyRows({ ...base, sourceCount: 1, job: finished });
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["add", "done"],
      ["transcribe", "queued"],
      ["align", "queued"],
      ["clean", "queued"],
      ["suggest", "queued"],
    ]);
    expect(rows[1]).toMatchObject({
      detail: "Not transcribed yet",
      action: { label: "Start", run: "try-again" },
    });
    expect(
      readyRows({ ...base, job: finished, starting: true })[1],
    ).toMatchObject({
      state: "queued",
      detail: "Starts in a moment",
    });
    expect(
      preparePhase({
        sources: 1,
        ingestBusy: false,
        checking: false,
        rows: readyRows({ ...base, job: finished, starting: true }),
      }).phase,
    ).toBe("transcribing");
  });

  it("keeps a finished run done once every source has a transcript", () => {
    const finished = pipelineJobSnapshot({
      status: "ok",
      steps: [step("transcribe", "ok"), step("analyze", "ok")],
    });
    const rows = readyRows({
      ...base,
      transcribed: true,
      job: finished,
    });
    expect(rows.every((r) => r.state === "done")).toBe(true);
  });

  it("reads done after a finished run when a source has no speech", () => {
    const finished = pipelineJobSnapshot({
      status: "ok",
      steps: [step("transcribe", "ok"), step("analyze", "ok")],
    });
    const rows = readyRows({
      ...base,
      transcribed: false,
      jobCoversMedia: true,
      job: finished,
    });
    expect(rows.every((r) => r.state === "done")).toBe(true);
    expect(
      preparePhase({ sources: 3, ingestBusy: false, checking: false, rows })
        .phase,
    ).toBe("done");
  });

  it("does not read done when audio arrived after the finished run", () => {
    const finished = pipelineJobSnapshot({
      status: "ok",
      steps: [step("transcribe", "ok"), step("analyze", "ok")],
    });
    const rows = readyRows({
      ...base,
      transcribed: false,
      jobCoversMedia: false,
      job: finished,
      startError: "Network down",
    });
    expect(rows[1]).toMatchObject({
      state: "failed",
      action: { label: "Try again", run: "try-again" },
    });
    expect(rows.some((r) => r.state === "done" && r.id !== "add")).toBe(false);
  });

  it("shows a start that failed as a failed row with Try again", () => {
    const finished = pipelineJobSnapshot({
      status: "ok",
      steps: [step("transcribe", "ok"), step("analyze", "ok")],
    });
    const rows = readyRows({
      ...base,
      sourceCount: 1,
      job: finished,
      startError: "Network down",
    });
    expect(rows[1]).toMatchObject({
      state: "failed",
      action: { label: "Try again", run: "try-again" },
    });
    expect(rows.some((r) => r.state === "done" && r.id !== "add")).toBe(false);
    const phase = preparePhase({
      sources: 1,
      ingestBusy: false,
      checking: false,
      rows,
    });
    expect(phase.phase).toBe("failed");
  });

  it("says why a refused run stopped, with Try again", () => {
    const job = pipelineJobSnapshot({
      status: "error",
      error: "refusing to replace edited transcripts in an unattended run",
      error_code: "transcript_overwrite_refused",
      steps: [
        step("transcribe_tracks", "error", {
          error: "refusing to replace edited transcripts in an unattended run",
        }),
      ],
    });
    expect(readyRows({ ...base, job })[1]).toMatchObject({
      state: "failed",
      detail: "The audio changed on a track with hand fixes.",
      action: { label: "Try again", run: "try-again" },
    });
  });

  it("shows the import while files are being added", () => {
    expect(readyRows({ ...base, ingestBusy: true })[0]).toMatchObject({
      state: "running",
      detail: "Adding files",
    });
  });

  it("shows a settled project as done without a job", () => {
    const rows = readyRows({
      ...base,
      transcribed: true,
      pendingSuggestions: 14,
    });
    expect(rows.every((r) => r.state === "done")).toBe(true);
    expect(rows[4].detail).toBe("14 suggestions");
    expect(rows[1].detail).toBe("3 speakers");
  });

  it("says nothing needs lining up for one track", () => {
    const rows = readyRows({ ...base, sourceCount: 1, transcribed: true });
    expect(rows[2].detail).toBe("One track, nothing to line up");
  });

  it("asks for the model with its size and keeps the other rows going", () => {
    const model: ModelAsk = {
      phase: "ask",
      size: "1.6 GB",
      what: "the transcription model",
    };
    const rows = readyRows({
      ...base,
      model,
      job: pipelineJobSnapshot({
        status: "running",
        steps: [step("ingest_tracks", "ok"), step("clean_audio", "running")],
      }),
    });
    expect(rows[1]).toMatchObject({
      state: "needs-you",
      action: {
        label: "Get (1.6 GB)",
        icon: "cloud-download",
        run: "download-model",
      },
    });
    expect(rows[3].state).toBe("running");
  });

  it("follows the model download, and a failed one asks again", () => {
    expect(
      readyRows({
        ...base,
        model: {
          phase: "downloading",
          size: "1.6 GB",
          what: "the transcription model",
          progress: 0.4,
        },
      })[1],
    ).toMatchObject({ state: "running", progress: 0.4 });
    expect(
      readyRows({
        ...base,
        model: {
          phase: "downloading",
          size: "1.6 GB",
          what: "the transcription model",
        },
      })[1].action,
    ).toBeUndefined();
    const failed = readyRows({
      ...base,
      model: {
        phase: "failed",
        size: "1.6 GB",
        what: "the transcription model",
        failure: "No connection.",
      },
    })[1];
    expect(failed.detail).toBe("No connection. Try again.");
    expect(failed.action?.run).toBe("download-model");
  });

  it("asks to keep hand fixes before transcribing again", () => {
    const row = readyRows({
      ...base,
      transcribed: true,
      keepFixes: { names: ["Maya", "Joss"] },
    })[1];
    expect(row).toMatchObject({
      state: "needs-you",
      detail: "You fixed words on Maya, Joss",
      body: { kind: "keep-fixes" },
    });
  });

  it("flags approximate word timing with the download", () => {
    const row = readyRows({
      ...base,
      transcribed: true,
      approximateTiming: { size: "360 MB", downloading: false },
    })[1];
    expect(row.action).toMatchObject({
      label: "Download word timing (360 MB)",
      run: "download-aligner",
    });
    expect(
      readyRows({
        ...base,
        transcribed: true,
        approximateTiming: { size: "360 MB", downloading: true },
      })[1].action,
    ).toBeUndefined();
  });

  it("fails a row with a plain detail and the raw cause behind Details", () => {
    const rows = readyRows({
      ...base,
      job: pipelineJobSnapshot({
        status: "error",
        steps: [
          step("ingest_tracks", "ok"),
          step("transcribe_tracks", "error", {
            error: "transcribe_tracks crashed at /var/tmp/a/b/c.wav",
          }),
        ],
      }),
    });
    expect(rows[1].state).toBe("failed");
    expect(rows[1].action).toEqual({ label: "Try again", run: "try-again" });
    expect(rows[1].details).toContain("transcribe_tracks");
    expect(rows[1].detail).not.toContain("/var/tmp");
  });
});

describe("readySummary", () => {
  const rows = (states: string[]) =>
    states.map((state, at) => ({
      id: (["add", "transcribe", "align", "clean", "suggest"] as const)[at],
      state: state as "done",
      title: ["Add audio", "Transcribe", "Line up tracks", "Clean", "Find"][at],
    }));

  it("counts what is done", () => {
    expect(
      readySummary(rows(["done", "done", "running", "queued", "queued"])),
    ).toBe("Getting ready: 2 of 5 done");
  });

  it("names a failure first, a need next, and says when all is done", () => {
    expect(
      readySummary(rows(["done", "failed", "queued", "queued", "queued"])),
    ).toBe("Getting ready: Transcribe failed");
    expect(
      readySummary(rows(["done", "needs-you", "queued", "queued", "queued"])),
    ).toBe("Getting ready: 1 of 5 done, Transcribe needs you");
    expect(
      readySummary(
        rows(["done", "needs-you", "needs-you", "queued", "queued"]),
      ),
    ).toBe("Getting ready: 1 of 5 done, 2 need you");
    expect(readySummary(rows(["done", "done", "done", "done", "done"]))).toBe(
      "Getting ready: all done",
    );
    expect(readySummary([])).toBe("");
  });
});

describe("busy slot", () => {
  it("shows a Run row and a waiting phase, not Not started, while the slot is taken", () => {
    const rows = readyRows({ ...base, waiting: true });
    expect(rows[1]).toMatchObject({
      state: "needs-you",
      action: { label: "Run", run: "try-again" },
    });
    expect(
      preparePhase({
        sources: 3,
        ingestBusy: false,
        checking: false,
        waiting: true,
        rows,
      }).phase,
    ).toBe("waiting");
    expect(isWorking("waiting")).toBe(false);
  });
});

describe("preparePhase", () => {
  const rows = (over: Partial<ReadyInput> = {}) =>
    readyRows({ ...base, ...over });

  it("walks from empty through the import to the work", () => {
    expect(
      preparePhase({
        sources: 0,
        ingestBusy: false,
        checking: false,
        rows: [],
      }),
    ).toEqual({ phase: "empty" });
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: true,
        checking: false,
        rows: rows(),
      }),
    ).toEqual({ phase: "adding" });
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: true,
        rows: rows(),
      }),
    ).toEqual({ phase: "checking" });
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: false,
        rows: rows({ job: pipelineJobSnapshot({ status: "running" }) }),
      }),
    ).toEqual({ phase: "transcribing" });
  });

  it("is not-started, not transcribing, when nothing runs and the rows offer Start", () => {
    const idle = rows();
    expect(idle[1]).toMatchObject({
      state: "queued",
      action: { label: "Start" },
    });
    const { phase } = preparePhase({
      sources: 2,
      ingestBusy: false,
      checking: false,
      rows: idle,
    });
    expect(phase).toBe("not-started");
    expect(isWorking(phase)).toBe(false);
  });

  it("is needs-model, with the hand-off open, while the model is asked for, downloading or failed", () => {
    for (const phase of ["ask", "downloading", "failed"] as const) {
      const model: ModelAsk = {
        phase,
        size: "1.6 GB",
        what: "the transcription model",
      };
      const result = preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: false,
        model,
        rows: rows({ model }),
      });
      expect(result.phase).toBe(
        phase === "failed" ? "model-failed" : "needs-model",
      );
      expect(handoffProps(result.phase, { label: "Edit" }).disabledReason).toBe(
        undefined,
      );
    }
    expect(
      readyRows({
        ...base,
        model: {
          phase: "ask",
          size: "1.6 GB",
          what: "the transcription model",
        },
      })[1].detail,
    ).toBe("Needs the transcription model before it can start.");
  });

  it("is done when every row is", () => {
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: false,
        rows: rows({ transcribed: true }),
      }).phase,
    ).toBe("done");
  });

  it("is done, not transcribing, while only word timing waits to be downloaded", () => {
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: false,
        rows: rows({
          transcribed: true,
          approximateTiming: { size: "360 MB", downloading: false },
        }),
      }).phase,
    ).toBe("done");
  });

  it("is failed with the step and its plain cause", () => {
    const failing = rows({
      job: pipelineJobSnapshot({
        status: "error",
        steps: [step("clean_audio", "error", { error: "Out of memory." })],
      }),
    });
    expect(
      preparePhase({
        sources: 2,
        ingestBusy: false,
        checking: false,
        rows: failing,
      }),
    ).toEqual({
      phase: "failed",
      failure: { step: "Cleaning", cause: "Out of memory." },
    });
  });
});

describe("prepareHandoff", () => {
  it("offers Review with the count once decisions wait", () => {
    expect(prepareHandoff({ pendingReviewCount: 14 })).toEqual({
      label: "Review 14 suggestions",
      target: "review",
    });
    expect(prepareHandoff({ pendingReviewCount: 1 }).label).toBe(
      "Review 1 suggestion",
    );
  });

  it("offers Edit when nothing waits", () => {
    expect(prepareHandoff({ pendingReviewCount: 0 })).toEqual({
      label: "Edit",
      target: "edit",
    });
  });
});

describe("handoffProps", () => {
  it("is offered but quiet, with its reason, while work runs", () => {
    for (const phase of ["adding", "checking", "transcribing"] as const) {
      expect(handoffProps(phase, { label: "Edit" })).toEqual({
        label: "Edit",
        disabledReason: STILL_GETTING_READY,
      });
    }
  });

  it("has no reason once the work is over, failed or waiting for the person", () => {
    for (const phase of ["done", "failed", "needs-model", "empty"] as const) {
      expect(handoffProps(phase, { label: "Edit" })).toEqual({ label: "Edit" });
    }
  });
});

describe("cleanup settings", () => {
  it("defaults to Medium and Podcast", () => {
    expect(cleanupFromConfig(null)).toEqual({
      tight: "medium",
      loudness: "podcast",
    });
    expect(cleanupFromConfig({})).toEqual({
      tight: "medium",
      loudness: "podcast",
    });
  });

  it("reads tighten intensity and the master loudness", () => {
    expect(
      cleanupFromConfig({
        tighten: { intensity: "aggressive" },
        master: { integrated_lufs: -23 },
      }),
    ).toEqual({ tight: "tight", loudness: "broadcast" });
    expect(
      cleanupFromConfig({
        tighten: { intensity: "light" },
        master: { integrated_lufs: -14 },
      }),
    ).toEqual({ tight: "light", loudness: "streaming" });
  });

  it("shows the nearest loudness for a custom target", () => {
    expect(
      cleanupFromConfig({ master: { integrated_lufs: -18 } }).loudness,
    ).toBe("podcast");
    expect(
      cleanupFromConfig({ master: { integrated_lufs: -21 } }).loudness,
    ).toBe("broadcast");
  });

  it("writes Light, Medium, Tight as the existing intensities and the loudness in LUFS", () => {
    const config = { tighten: { intensity: "medium", max_pause_sec: 1.2 } };
    expect(
      applyCleanup(config, { tight: "tight", loudness: "streaming" }),
    ).toEqual({
      tighten: { intensity: "aggressive", max_pause_sec: 1.2 },
      master: { integrated_lufs: -14 },
    });
    expect(
      applyCleanup(config, { tight: "light", loudness: "broadcast" }),
    ).toMatchObject({
      tighten: { intensity: "light" },
      master: { integrated_lufs: -23 },
    });
    expect(config.tighten.intensity).toBe("medium");
  });
});

describe("vocabulary chips", () => {
  const saved = { terms: ["Quetzalcoatlus"], guest_names: ["Okonkwo"] };

  it("shows terms and guest names once each", () => {
    expect(
      vocabularyChips({ terms: ["a", "b"], guest_names: ["b", "c"] }),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps a guest name a guest name and files a new chip as a term", () => {
    expect(
      vocabularyFromChips(saved, ["Quetzalcoatlus", "Okonkwo", "Hyperion"]),
    ).toEqual({
      terms: ["Quetzalcoatlus", "Hyperion"],
      guest_names: ["Okonkwo"],
    });
  });

  it("drops a removed chip from its list", () => {
    expect(vocabularyFromChips(saved, ["Okonkwo"])).toEqual({
      terms: [],
      guest_names: ["Okonkwo"],
    });
  });
});
