import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page, Response } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  assessEditingTrial,
  type DurableState,
  type EditingTrial,
  savedStateDifferences,
  summarizeEditingAttempts,
  type TaskDefinition,
} from "./editingTaskReport";
import {
  editingResponseOutcome,
  editingTaskRegistry,
  navigateEditingTimeline,
  readEditingState,
  retainEditingMedia,
  tabToEditingControl,
  verifyEditingDistribution,
} from "./editingTasks";

const start: DurableState = {
  duration_sec: 20,
  stable: {},
  sources: [
    {
      id: "reference_src0",
      path: "reference.wav",
      speaker: "reference",
      label: "reference.wav",
      offset_sec: 0,
      duration_sec: null,
      sample_rate: null,
      channels: null,
      clipping_regions: [],
      clipping_truncated: false,
    },
  ],
  clips: [
    {
      id: "a",
      track_id: "reference",
      source_start: 0,
      source_end: 5,
      timeline_start: 0,
      fade_in_ms: 0,
      fade_out_ms: 0,
      source_id: null,
      join_in_mode: "fade",
      mute_regions: [],
    },
  ],
  tracks: [
    {
      id: "reference",
      fader_db: 0,
      gain_db: 0,
      muted: false,
      role: "dialogue",
      media: { path: "raw/reference.wav" },
      invariants: {},
    },
  ],
  envelopes: [],
  comments: [],
};
const definition: TaskDefinition = {
  id: "trim",
  historyOperation: "trim_clip_edge",
  family: "trim-fade",
  viewport: { width: 1440, height: 900 },
  start,
  expected: {
    ...start,
    clips: [{ ...start.clips[0], source_start: 0.3, timeline_start: 0.3 }],
  },
  routes: [
    {
      id: "keyboard",
      input: "keyboard",
      command: "TrimClipEdge",
      mutations: 1,
      cancel: true,
      undo: "history",
    },
  ],
  tolerances: {},
};
function trial(): EditingTrial {
  return {
    task: "trim",
    route: "keyboard",
    mode: "validity-only",
    journal: [
      {
        seq: 1,
        phase: "action",
        kind: "activation",
        label: "trim",
        verb: "key-burst",
        outcome: "completed",
      },
      {
        seq: 2,
        phase: "action",
        kind: "request",
        requestId: 1,
        type: "TrimClipEdge",
        body: '{"source_sec":0.3}',
      },
      {
        seq: 3,
        phase: "action",
        kind: "response",
        requestId: 1,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      },
      {
        seq: 4,
        phase: "cancel",
        kind: "activation",
        label: "cancel preview",
        verb: "key",
        outcome: "completed",
      },
      {
        seq: 5,
        phase: "undo",
        kind: "activation",
        label: "Undo",
        verb: "key",
        outcome: "completed",
      },
      {
        seq: 6,
        phase: "undo",
        kind: "request",
        requestId: 2,
        type: "UndoHistory",
        body: "{}",
      },
      {
        seq: 7,
        phase: "undo",
        kind: "response",
        requestId: 2,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      },
    ],
    before: start,
    after: definition.expected,
    canceled: start,
    undone: start,
    durationMs: 10,
    history: {
      before: { cursor: -1, headId: null, entries: [] },
      after: {
        cursor: 1,
        headId: "changed",
        entries: [
          { id: "baseline", label: "before trim clip edge", operation: null },
          {
            id: "changed",
            label: "after trim clip edge",
            operation: "trim_clip_edge",
          },
        ],
      },
      undone: {
        cursor: 0,
        headId: "baseline",
        entries: [
          { id: "baseline", label: "before trim clip edge", operation: null },
          {
            id: "changed",
            label: "after trim clip edge",
            operation: "trim_clip_edge",
          },
        ],
      },
    },
  };
}
describe("literal editing task admission", () => {
  it("accepts completed saved work and derives deliberate input", () => {
    expect(assessEditingTrial(definition, trial())).toEqual({
      status: "pass",
      reasons: [],
      activations: { setup: 0, action: 1, cancel: 1, undo: 1 },
      mutations: 1,
      accidentalCommands: 0,
      completedWork: 1,
      canceledReads: 0,
      observations: { save: "pass", cancel: "pass", undo: "pass" },
    });
  });
  it("rejects unchanged state despite correct outgoing target", () => {
    expect(
      assessEditingTrial(definition, { ...trial(), after: start }).reasons,
    ).toEqual([
      "after.clips.a.source_start expected 0.3, observed 0",
      "after.clips.a.timeline_start expected 0.3, observed 0",
      "task made no saved change",
    ]);
  });
  it("rejects unrelated saved changes", () => {
    expect(
      assessEditingTrial(definition, {
        ...trial(),
        after: {
          ...definition.expected,
          tracks: [{ ...start.tracks[0], fader_db: -6 }],
        },
      }).reasons,
    ).toEqual(["after.tracks.0.fader_db expected 0, observed -6"]);
  });
  it("rejects an earlier failed cancellation even when the last clone is restored", () => {
    expect(
      assessEditingTrial(definition, {
        ...trial(),
        cancellations: [
          { probe: "short", state: definition.expected },
          { probe: "touch-cancel", state: start },
        ],
      }).reasons,
    ).toEqual([
      "canceled-short.clips.a.source_start expected 0, observed 0.3",
      "canceled-short.clips.a.timeline_start expected 0, observed 0.3",
    ]);
  });
  it("rejects ancillary app HTTP errors despite completed saved work", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      phase: "setup",
      kind: "error",
      message: "HTTP 500 GET /record/share-registry",
    });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "HTTP 500 GET /record/share-registry",
    ]);
  });
  it("requires recovery snapshots", () => {
    expect(
      assessEditingTrial(definition, {
        ...trial(),
        canceled: undefined,
        undone: undefined,
      }).reasons,
    ).toEqual(["cancellation not run", "Undo not run"]);
  });
  it("retains unknown responses and duplicate mutations as failures", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      phase: "action",
      kind: "request",
      requestId: 3,
      type: "Surprise",
      body: '{"ok":true,"type":"Applied"}',
    });
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "request 3 has no response",
      "unexpected action command Surprise",
    ]);
  });
  it("rejects fabricated recovery snapshots without browser input", () => {
    const t = trial();
    t.journal = t.journal.filter((event) => event.phase === "action");
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "cancel input not observed",
      "Undo input not observed",
      "Undo expected 1 UndoHistory commands, observed 0",
    ]);
  });
  it("rejects successful HTTP with an unknown command outcome", () => {
    const t = trial();
    t.journal[2] = {
      seq: 3,
      phase: "action",
      kind: "response",
      requestId: 1,
      status: 200,
      body: "{}",
    };
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "request 1 has unknown outcome",
    ]);
  });
});

it("rejects a non-finite stopped seek position", () => {
  const seek: TaskDefinition = {
    ...definition,
    id: "seek",
    seek: 5,
    expected: start,
    routes: [
      {
        id: "ruler",
        input: "keyboard",
        command: null,
        mutations: 0,
        cancel: false,
        undo: "none",
      },
    ],
  };
  const attempted: EditingTrial = {
    ...trial(),
    task: "seek",
    route: "ruler",
    journal: [
      {
        seq: 1,
        phase: "action",
        kind: "activation",
        label: "seek",
        verb: "key",
        outcome: "completed",
      },
    ],
    after: start,
    history: {
      before: { cursor: -1, headId: null, entries: [] },
      after: { cursor: -1, headId: null, entries: [] },
      undone: null,
    },
    transport: { seconds: Number.NaN, playing: false },
  };
  expect(assessEditingTrial(seek, attempted).reasons).toEqual([
    "seek position is not finite",
  ]);
});

it("excludes diagnostic and non-finite durations from five-trial statistics", () => {
  const rows = [
    {
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs: NaN,
    },
    ...[1, 2, 3, 4].map((durationMs) => ({
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs,
    })),
    {
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "diagnostic" as const,
      durationMs: 99,
    },
  ];
  expect(summarizeEditingAttempts([definition], rows)).toEqual([
    {
      task: "trim",
      route: "keyboard",
      status: "pass",
      reason: "Fewer than five valid baseline trials",
      attempted: 6,
      valid: 6,
      failed: 0,
      baselineValid: 4,
      duration: null,
    },
  ]);
  rows.push({
    task: "trim",
    route: "keyboard",
    valid: true,
    mode: "baseline",
    durationMs: 5,
  });
  expect(summarizeEditingAttempts([definition], rows)[0].duration).toEqual({
    medianMs: 3,
    minMs: 1,
    maxMs: 5,
  });
});

function canceledReadTrial(replaced: boolean): EditingTrial {
  const t = trial();
  const url =
    "http://127.0.0.1:1234/api/document/state?path=%2Ftmp%2Ftask.json&phase=detail";
  t.journal.push({
    seq: 8,
    phase: "setup",
    kind: "read-request",
    requestId: 3,
    url,
    method: "GET",
  });
  t.journal.push({
    seq: 9,
    phase: "setup",
    kind: "read-failed",
    requestId: 3,
    error: "net::ERR_ABORTED",
  });
  if (replaced) {
    t.journal.push({
      seq: 10,
      phase: "setup",
      kind: "read-request",
      requestId: 4,
      url,
      method: "GET",
    });
    t.journal.push({
      seq: 11,
      phase: "setup",
      kind: "read-response",
      requestId: 4,
      status: 200,
      body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
    });
  }
  return t;
}
it("rejects a canceled detail read without a successful replacement", () => {
  expect(
    assessEditingTrial(definition, canceledReadTrial(false)).reasons,
  ).toEqual(["read 3 failed net::ERR_ABORTED without admitted replacement"]);
});
it("retains and classifies the replaced setup detail read", () => {
  const result = assessEditingTrial(definition, canceledReadTrial(true));
  expect(result.status).toBe("pass");
  expect(result.canceledReads).toBe(1);
});

it.each(["action", "other-project", "HTTP500", "unknown-body"])(
  "rejects detail cancellation with %s replacement evidence",
  (fault) => {
    const t = canceledReadTrial(true);
    for (const row of t.journal) {
      if (
        (row.kind === "read-request" || row.kind === "read-failed") &&
        fault === "action"
      )
        row.phase = "action";
      if (
        row.kind === "read-request" &&
        row.requestId === 4 &&
        fault === "other-project"
      )
        row.url =
          "http://127.0.0.1:1234/api/document/state?path=%2Ftmp%2Fother.json&phase=detail";
      if (row.kind === "read-response" && fault === "HTTP500") row.status = 500;
      if (row.kind === "read-response" && fault === "unknown-body")
        row.body = "{}";
    }
    const result = assessEditingTrial(definition, t);
    expect(result.status).toBe("fail");
    expect(result.canceledReads).toBe(0);
  },
);

it("admits replacement before abort callback with valid source request order", () => {
  const t = canceledReadTrial(true);
  const failed = t.journal.find((row) => row.kind === "read-failed")!;
  const replacement = t.journal.find(
    (row) => row.kind === "read-request" && row.requestId === 4,
  )!;
  replacement.seq = 9;
  failed.seq = 10;
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  expect(assessEditingTrial(definition, t).canceledReads).toBe(1);
});

it.each(["same-request", "duplicate-response"])(
  "rejects %s as replacement read evidence",
  (fault) => {
    const t = canceledReadTrial(true);
    if (fault === "same-request") {
      for (const row of t.journal)
        if (
          (row.kind === "read-request" || row.kind === "read-response") &&
          row.requestId === 4
        )
          row.requestId = 3;
    } else {
      t.journal.push({
        seq: 12,
        phase: "setup",
        kind: "read-response",
        requestId: 4,
        status: 200,
        body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
      });
    }
    expect(assessEditingTrial(definition, t).status).toBe("fail");
    expect(assessEditingTrial(definition, t).canceledReads).toBe(0);
  },
);

it("compares clip identity independently of backend array order", () => {
  const expected = {
    ...start,
    clips: [
      { ...start.clips[0], id: "left", fade_out_ms: 10 },
      { ...start.clips[0], id: "peer", track_id: "guest" },
    ],
  };
  const observed = {
    ...expected,
    clips: [expected.clips[1], expected.clips[0]],
  };
  expect(savedStateDifferences(expected, observed)).toEqual([]);
});
it("requires literal automatic cut-edge fades", () => {
  const expected = {
    ...start,
    clips: [
      { ...start.clips[0], id: "cut-left", fade_out_ms: 10 },
      {
        ...start.clips[0],
        id: "cut-right",
        source_start: 2,
        timeline_start: 12,
        fade_in_ms: 10,
      },
    ],
  };
  const observed = {
    ...expected,
    clips: [
      { ...expected.clips[0], fade_out_ms: 0 },
      { ...expected.clips[1], fade_in_ms: 0 },
    ],
  };
  expect(savedStateDifferences(expected, observed)).toEqual([
    "after.clips.cut-left.fade_out_ms expected 10, observed 0",
    "after.clips.cut-right.fade_in_ms expected 10, observed 0",
  ]);
});

it("rejects replacement before original read", () => {
  const t = canceledReadTrial(true);
  for (const row of t.journal) {
    if (row.seq <= 7) row.seq++;
    else if (row.kind === "read-request") row.seq = row.requestId === 3 ? 9 : 1;
    else if (row.kind === "read-failed") row.seq = 10;
  }
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "read 3 failed net::ERR_ABORTED without admitted replacement",
  ]);
});
it("rejects replacement response before failed callback", () => {
  const t = canceledReadTrial(true);
  for (const row of t.journal) {
    if (row.kind === "read-failed") row.seq = 11;
    else if (row.kind === "read-response") row.seq = 9;
  }
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "outcome 4 order or phase differs",
    "read 3 failed net::ERR_ABORTED without admitted replacement",
  ]);
});

describe("fix-forward retained admission regressions", () => {
  it("rejects a successful setup Surprise command", () => {
    const t = trial();
    t.journal.push(
      {
        seq: 8,
        phase: "setup",
        kind: "request",
        requestId: 3,
        type: "Surprise",
        body: "{}",
      },
      {
        seq: 9,
        phase: "setup",
        kind: "response",
        requestId: 3,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      },
    );
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      accidentalCommands: 1,
    });
  });
  it.each([undefined, "broken", NaN, Infinity, 99, 600, 200.5])(
    "rejects malformed Undo status %s",
    (status) => {
      const t = trial();
      Object.assign(t.journal[6], { status });
      expect(assessEditingTrial(definition, t).status).toBe("fail");
    },
  );
  it.each([undefined, "1", NaN, Infinity, 0, 1.5])(
    "rejects malformed journal sequence %s",
    (seq) => {
      const t = trial();
      Object.assign(t.journal[0], { seq });
      expect(assessEditingTrial(definition, t).status).toBe("fail");
    },
  );
  it("rejects an orphan failed command response", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      phase: "undo",
      kind: "response",
      requestId: 999,
      status: 500,
      body: "{}",
    });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  });
  it("rejects a pending document read", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      phase: "action",
      kind: "read-request",
      requestId: 8,
      url: "http://localhost/api/document/state?path=x&phase=detail",
      method: "GET",
    });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  });
  it("rejects a successful unknown document snapshot", () => {
    const t = trial();
    t.journal.push(
      {
        seq: 8,
        phase: "action",
        kind: "read-request",
        requestId: 8,
        url: "http://localhost/api/document/state?path=x&phase=detail",
        method: "GET",
      },
      {
        seq: 9,
        phase: "action",
        kind: "read-response",
        requestId: 8,
        status: 200,
        body: "{}",
      },
    );
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  });
  it("rejects missing or unchanged History", () => {
    const t = trial();
    delete t.history;
    expect(assessEditingTrial(definition, t).status).toBe("fail");
    const empty = { cursor: -1, headId: null, entries: [] };
    t.history = { before: empty, after: empty, undone: empty };
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  });
});

it("admits materialized baseline and preserved Redo, and initialized History", () => {
  const t = trial();
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  t.history!.before = t.history!.undone;
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  t.history!.undone = {
    ...t.history!.undone!,
    entries: t.history!.undone!.entries.slice(0, 1),
  };
  expect(assessEditingTrial(definition, t).reasons).toContain(
    "History Undo transition differs",
  );
});
it.each(["setup", "action", "cancel", "undo"] as const)(
  "rejects orphan and malformed read outcomes in %s",
  (phase) => {
    const t = trial();
    t.journal.push({
      seq: 8,
      phase,
      kind: "read-response",
      requestId: 999,
      status: 200,
      body: "{}",
    });
    expect(assessEditingTrial(definition, t).reasons).toContain(
      "orphan outcome 999",
    );
    Object.assign(t.journal[7], { status: undefined });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([
  "matching",
  "missing-abort",
  "wrong-id",
  "action",
  "ordinary-error",
  "HTTP500",
])("admits only matching canceled body error %s", (fault) => {
  const t = canceledReadTrial(true);
  t.journal.push({
    seq: 12,
    phase: fault === "action" ? "action" : "setup",
    kind: "read-body-failed",
    requestId: fault === "wrong-id" ? 4 : 3,
    status: fault === "HTTP500" ? 500 : 200,
    error:
      fault === "ordinary-error"
        ? "ordinary failure"
        : "Error: response.text: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
  });
  if (fault === "missing-abort")
    t.journal = t.journal.filter((row) => row.kind !== "read-failed");
  expect(assessEditingTrial(definition, t).status).toBe(
    fault === "matching" ? "pass" : "fail",
  );
});

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function smallProject(dir: string) {
  const baseline = editingTaskRegistry[0].start;
  const project = {
    sources: [
      {
        id: "reference_src0",
        path: "reference.wav",
        speaker: "reference",
        label: "reference.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
      {
        id: "guest_src0",
        path: "guest.wav",
        speaker: "guest",
        label: "guest.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
    ],
    timeline: {
      duration_sec: 20,
      clips: structuredClone(baseline.clips),
      tracks: baseline.tracks.map(({ invariants, ...row }) => ({
        ...row,
        ...(invariants as object),
      })),
    },
    editorial: {
      chapters: [],
      speaker_splits: [],
      retained_bleed_alignments: [],
    },
    mix: { automation_envelopes: [], processing_chains: [] },
    social: { clip_candidates: [] },
    review: { comments: [], versions: [], active_version_id: null },
  };
  const file = path.join(dir, "episode.project.json");
  fs.writeFileSync(file, JSON.stringify(project));
  return { project, file };
}
it("binds saved source identity and recording path through the real reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-source-test-"));
  try {
    const { project, file } = smallProject(dir);
    project.timeline.clips[0].source_id = "reference_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    const before = readEditingState(file);
    expect(savedStateDifferences(before, readEditingState(file))).toEqual([]);

    project.sources[0].path = "guest.wav";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(before, readEditingState(file)).some((path) =>
        path.includes("sources.0.path"),
      ),
    ).toBe(true);

    project.sources[0].path = "reference.wav";
    project.timeline.clips[0].source_id = "guest_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(before, readEditingState(file)).some((path) =>
        path.includes("source_id"),
      ),
    ).toBe(true);

    project.timeline.clips[0].source_id = "reference_src0";
    project.sources = project.sources.slice(1);
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file)).toThrow(
      "Durable clip references a missing source",
    );

    project.sources = [
      {
        id: "reference_src0",
        path: "reference.wav",
        speaker: "reference",
        label: "reference.wav",
        offset_sec: 0,
        duration_sec: null,
        sample_rate: null,
        channels: null,
        clipping_regions: [],
        clipping_truncated: false,
      },
      ...project.sources,
    ];
    project.sources[1].id = "reference_src0";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file)).toThrow(
      "Invalid or duplicate durable source identity",
    );

    project.sources = [];
    project.timeline.clips[0].source_id = null;
    fs.writeFileSync(file, JSON.stringify(project));
    expect(readEditingState(file).sources).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("rejects identical raw split IDs before aliases and preserves unaffected identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-identity-test-"));
  try {
    const { project, file } = smallProject(dir);
    project.timeline.clips = structuredClone(
      editingTaskRegistry[1].expected.clips,
    );
    project.timeline.clips[1].id = "same-duplicate-id";
    project.timeline.clips[2].id = "same-duplicate-id";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(() => readEditingState(file, true)).toThrow(
      "Raw saved clip IDs are not unique",
    );
    project.timeline.clips[2].id = "generated-right";
    fs.writeFileSync(file, JSON.stringify(project));
    const mapping: Record<string, string> = {};
    expect(readEditingState(file, true, mapping)).toEqual(
      editingTaskRegistry[1].expected,
    );
    expect(mapping).toEqual({
      "first-copy": "first-copy",
      "same-duplicate-id": "cut-left",
      "generated-right": "cut-right",
      peer: "peer",
    });
    project.timeline.clips[1].id = "second-copy";
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(
        editingTaskRegistry[1].expected,
        readEditingState(file, true),
      ).length,
    ).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  "duration",
  "role",
  "media",
  "chapters",
  "extra-clip",
  "wrong-occurrence",
  "no-op",
])("rejects saved %s through actual reader", (fault) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-state-test-"));
  try {
    const { project, file } = smallProject(dir);
    const task = editingTaskRegistry[2];
    project.timeline.clips = structuredClone(task.expected.clips);
    project.timeline.duration_sec = 19.7;
    if (fault === "duration") project.timeline.duration_sec = 999;
    if (fault === "role") project.timeline.tracks[0].role = "music";
    if (fault === "media")
      project.timeline.tracks[0].media = {
        path: "raw/guest.wav",
        duration_sec: 60,
        sample_rate: 48000,
        channels: 1,
      };
    if (fault === "chapters")
      Object.assign(project.editorial, { chapters: [{ id: "unexpected" }] });
    if (fault === "extra-clip")
      project.timeline.clips.push({
        ...project.timeline.clips[0],
        id: "extra",
      });
    if (fault === "wrong-occurrence") {
      project.timeline.clips[0].source_start = 0;
      project.timeline.clips[1].source_start = 0.3;
    }
    if (fault === "no-op") {
      project.timeline.clips = structuredClone(task.start.clips);
      project.timeline.duration_sec = 20;
    }
    fs.writeFileSync(file, JSON.stringify(project));
    expect(
      savedStateDifferences(task.expected, readEditingState(file)).length,
    ).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("requires complete index and public asset inventory and exact hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-dist-test-"));
  try {
    fs.writeFileSync(path.join(dir, "index.html"), "app");
    fs.writeFileSync(path.join(dir, "favicon.svg"), "icon");
    const assets = {
      "index.html": digest("app"),
      "favicon.svg": digest("icon"),
    };
    expect(verifyEditingDistribution(dir, assets)).toEqual(assets);
    expect(() => verifyEditingDistribution(dir, {})).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, { "index.html": digest("app") }),
    ).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, { ...assets, "extra.js": digest("x") }),
    ).toThrow("inventory");
    expect(() =>
      verifyEditingDistribution(dir, {
        ...assets,
        "index.html": digest("wrong"),
      }),
    ).toThrow("mismatch");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("retains every distinct mismatching and unexpected media input before aggregate failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-media-test-"));
  try {
    const { file } = smallProject(dir);
    fs.mkdirSync(path.join(dir, "raw"));
    const evidence = path.join(dir, "evidence");
    fs.mkdirSync(evidence);
    const replay: Record<
      string,
      { relativePath: string; retainedPath: string; sha256: string }
    > = {};
    for (const id of ["reference", "guest"]) {
      const retainedPath = path.join(dir, `expected-${id}`);
      fs.writeFileSync(retainedPath, "expected");
      fs.writeFileSync(path.join(dir, "raw", `${id}.wav`), `unique-${id}`);
      replay[id] = {
        relativePath: `raw/${id}.wav`,
        retainedPath,
        sha256: digest("expected"),
      };
    }
    fs.writeFileSync(
      path.join(dir, "raw", "unexpected.wav"),
      "unique-unexpected",
    );
    expect(() => retainEditingMedia(dir, file, evidence, replay)).toThrow(
      /reference.*guest.*unexpected/,
    );
    const map = JSON.parse(
      fs.readFileSync(
        path.join(evidence, `media-map-${path.basename(dir)}.json`),
        "utf8",
      ),
    );
    for (const [id, bytes] of [
      ["reference", "unique-reference"],
      ["guest", "unique-guest"],
      ["raw/unexpected.wav", "unique-unexpected"],
    ]) {
      expect(fs.readFileSync(map.media[id].retainedPath, "utf8")).toBe(bytes);
      expect(map.media[id].sha256).toBe(digest(bytes));
    }
    fs.unlinkSync(path.join(dir, "raw", "unexpected.wav"));
    for (const id of ["reference", "guest"])
      fs.writeFileSync(path.join(dir, "raw", `${id}.wav`), "expected");
    expect(
      Object.keys(retainEditingMedia(dir, file, evidence, replay)),
    ).toEqual(["reference", "guest"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("records response-body failure at its originating request phase and status", async () => {
  const response = {
    status: () => 200,
    text: async () => {
      throw new Error(
        "Network.getResponseBody: No data found for resource with given identifier",
      );
    },
  } as unknown as Response;
  expect(
    await editingResponseOutcome(response, {
      id: 63,
      phase: "setup",
      kind: "read",
    }),
  ).toEqual({
    phase: "setup",
    kind: "read-body-failed",
    requestId: 63,
    status: 200,
    error:
      "Error: Network.getResponseBody: No data found for resource with given identifier",
  });
  expect(
    await editingResponseOutcome(response, {
      id: 63,
      phase: "action",
      kind: "command",
    }),
  ).toEqual({
    phase: "action",
    kind: "error",
    message:
      "response 63: Error: Network.getResponseBody: No data found for resource with given identifier",
  });
});
it("navigates from Listen through counted Timeline input", async () => {
  let visible = false;
  const labels: string[] = [];
  const timeline = {
    isVisible: async () => visible,
    waitFor: async () => {
      if (!visible) throw new Error("Timeline unavailable");
    },
  };
  const button = {
    click: async () => {
      visible = true;
    },
  };
  const page = {
    locator: () => timeline,
    getByRole: () => ({ getByRole: () => button }),
  } as unknown as Page;
  await navigateEditingTimeline(page, async (control, label) => {
    labels.push(label);
    await control.click();
  });
  expect({ visible, labels }).toEqual({
    visible: true,
    labels: ["Primary Timeline"],
  });
  await navigateEditingTimeline(page, async (control, label) => {
    labels.push(label);
    await control.click();
  });
  expect(labels).toEqual(["Primary Timeline"]);
});
it("counts every Tab and Enter to open the shipped header", async () => {
  let tabs = 0,
    opened = false;
  const inputs: string[] = [];
  const control = {
    evaluate: async () => tabs === 3,
    _expect: async () => ({ matches: tabs === 3 }),
  } as unknown as Locator;
  await tabToEditingControl(control, async (value) => {
    inputs.push(value);
    if (value === "Tab") tabs++;
    else opened = true;
  });
  expect({ opened, inputs }).toEqual({
    opened: true,
    inputs: ["Tab", "Tab", "Tab", "Enter"],
  });
});
it("admits reachable 40ms fade and rejects unchanged zero", () => {
  const task = editingTaskRegistry.find((row) => row.id === "fade")!;
  const t = trial();
  Object.assign(t, {
    task: "fade",
    route: "corner-pointer",
    before: task.start,
    after: {
      ...task.expected,
      clips: [
        { ...task.start.clips[0], fade_in_ms: 40 },
        task.start.clips[1],
        task.start.clips[2],
      ],
    },
    canceled: task.start,
    undone: task.start,
  });
  const command = t.journal.find(
    (row) => row.kind === "request" && row.phase === "action",
  )!;
  Object.assign(command, { type: "SetClipFade" });
  for (const stage of [t.history!.after!, t.history!.undone!])
    stage.entries[1] = {
      id: "changed",
      label: "after set clip fade",
      operation: "set_clip_fade",
    };
  for (const stage of [t.history!.after!, t.history!.undone!])
    stage.entries[0].label = "before set clip fade";
  expect(assessEditingTrial(task, t).status).toBe("pass");
  t.after = task.start;
  expect(assessEditingTrial(task, t).status).toBe("fail");
});

it("requires separate resolve and unresolve comment History mutations", () => {
  const task = editingTaskRegistry.find((row) => row.id === "comment")!;
  const t = trial();
  Object.assign(t, {
    task: "comment",
    route: "resolve-button",
    before: task.start,
    after: task.expected,
    undone: task.start,
  });
  for (const row of t.journal)
    if (row.kind === "request") row.type = "ResolveComment";
  const baseline = {
    id: "baseline",
    label: "before resolve comment",
    operation: null,
  };
  const resolved = {
    id: "resolved",
    label: "after resolve comment",
    operation: null,
  };
  const restored = {
    id: "restored",
    label: "after unresolve comment",
    operation: null,
  };
  t.history = {
    before: { cursor: -1, headId: null, entries: [] },
    after: { cursor: 1, headId: "resolved", entries: [baseline, resolved] },
    undone: {
      cursor: 2,
      headId: "restored",
      entries: [baseline, resolved, restored],
    },
  };
  expect(assessEditingTrial(task, t).status).toBe("pass");
  t.history.undone = {
    cursor: 0,
    headId: "baseline",
    entries: [baseline, resolved],
  };
  expect(assessEditingTrial(task, t).reasons).toContain(
    "Comment toast History transition differs",
  );
});
it.each(["duplicate", "wrong-phase", "wrong-order", "wrong-Undo"])(
  "rejects command ownership %s",
  (fault) => {
    const t = trial();
    if (fault === "duplicate") t.journal.push({ ...t.journal[6], seq: 8 });
    else if (fault === "wrong-phase") t.journal[6].phase = "action";
    else if (fault === "wrong-order") t.journal[6].seq = 1;
    else Object.assign(t.journal[5], { type: "Surprise" });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([undefined, "3", NaN, Infinity, 0, 1.5])(
  "rejects retained request ID %s",
  (requestId) => {
    const t = trial();
    Object.assign(t.journal[5], { requestId });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);

it("reads nullable current source descriptors and rejects fractional recording counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-null-source-"));
  try {
    const { project, file } = smallProject(dir);
    Object.assign(project.sources[0], { speaker: null, label: null });
    fs.writeFileSync(file, JSON.stringify(project));
    expect(readEditingState(file).sources[0]).toEqual({
      id: "reference_src0",
      path: "reference.wav",
      speaker: null,
      label: null,
      offset_sec: 0,
      duration_sec: null,
      sample_rate: null,
      channels: null,
      clipping_regions: [],
      clipping_truncated: false,
    });
    for (const key of ["sample_rate", "channels"]) {
      Object.assign(project.sources[0], { [key]: 1.5 });
      fs.writeFileSync(file, JSON.stringify(project));
      expect(() => readEditingState(file)).toThrow(
        "Invalid or duplicate durable source identity",
      );
      Object.assign(project.sources[0], { [key]: null });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  "gui/web/index.html",
  ".agents/defaults/pipeline.yaml",
  "contracts/timeline-zoom.json",
])(
  "rejects changed production input %s through the actual CLI before launch",
  (inputPath) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editing-cli-source-"));
    try {
      const web = path.join(dir, "gui/web");
      fs.mkdirSync(web, { recursive: true });
      const raw = path.join(dir, "tests/fixtures/aligned_dialogue/raw");
      fs.mkdirSync(raw, { recursive: true });
      for (const id of ["reference", "guest"])
        fs.writeFileSync(path.join(raw, `${id}.wav`), id);
      const index = path.join(dir, inputPath);
      fs.mkdirSync(path.dirname(index), { recursive: true });
      fs.writeFileSync(index, "original HTML");
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      const base = git("rev-parse", "HEAD");
      fs.writeFileSync(index, "changed HTML");
      const result = spawnSync(
        process.execPath,
        [
          path.resolve("node_modules/vite-node/dist/cli.mjs"),
          path.resolve("scripts/profile-editing-tasks.ts"),
          "--app-base",
          base,
          "--validity-only",
          "--trials",
          "1",
          "--out",
          path.join(dir, "evidence"),
        ],
        { cwd: web, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `Product source differs from app-base ${inputPath}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
