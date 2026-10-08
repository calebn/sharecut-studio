import { describe, expect, it } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  assessEditingTrial,
  type DurableState,
  type EditingTrial,
  savedStateDifferences,
  summarizeEditingAttempts,
  type TaskDefinition,
} from "./editingTaskReport";

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
      status: "fail",
      reason: "Fewer than five valid baseline trials",
      attempted: 6,
      valid: 5,
      failed: 1,
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

it("rejects missing stopped observation and invalid elapsed durations at admission", () => {
  const task = editingTaskRegistry[0];
  const t: EditingTrial = {
    task: "seek",
    route: "ruler-keyboard",
    mode: "validity-only",
    before: task.start,
    after: task.expected,
    durationMs: 0,
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
    transport: { seconds: 5, playing: false },
    history: {
      before: { cursor: -1, headId: null, entries: [] },
      after: { cursor: -1, headId: null, entries: [] },
      undone: null,
    },
  };
  expect(assessEditingTrial(task, t).status).toBe("pass");
  for (const playing of [undefined, null, 0, "false", true]) {
    Object.assign(t.transport!, { playing });
    expect(assessEditingTrial(task, t).status).toBe("fail");
  }
  t.transport!.playing = false;
  for (const durationMs of [undefined, -10, NaN, Infinity, "10", null]) {
    Object.assign(t, { durationMs });
    expect(assessEditingTrial(task, t).status).toBe("fail");
  }
});
it("excludes negative and missing elapsed durations from baseline admission", () => {
  const rows = [-10, undefined, NaN, Infinity, 0, 1, 2, 3, 4].map(
    (durationMs) => ({
      task: "trim",
      route: "keyboard",
      valid: true,
      mode: "baseline" as const,
      durationMs,
    }),
  );
  expect(summarizeEditingAttempts([definition], rows)[0]).toMatchObject({
    status: "fail",
    valid: 5,
    failed: 4,
    baselineValid: 5,
    duration: { medianMs: 2, minMs: 0, maxMs: 4 },
  });
});
it.each([undefined, -10, NaN, Infinity, "10", null])(
  "rejects elapsed duration %s independently",
  (durationMs) => {
    const t = trial();
    Object.assign(t, { durationMs });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
