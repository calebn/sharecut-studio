import { describe, expect, it } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  assessEditingTrial,
  type EditingTrial,
  summarizeEditingAttempts,
  type TaskDefinition,
} from "./editingTaskReport";
import { type DurableState, savedStateDifferences } from "./editingTaskState";

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
      cancellation: [{ id: "cancel", input: { kind: "route-cancel" } }],
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
        owner: "main",
        phase: "action",
        kind: "activation",
        label: "trim",
        verb: "key-burst",
        outcome: "completed",
      },
      {
        seq: 2,
        owner: "main",
        phase: "action",
        kind: "request",
        requestId: 1,
        type: "TrimClipEdge",
        body: '{"source_sec":0.3}',
      },
      {
        seq: 3,
        owner: "main",
        phase: "action",
        kind: "response",
        requestId: 1,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      },
      {
        seq: 4,
        owner: "cancel",
        probe: "cancel",
        phase: "cancel",
        kind: "activation",
        label: "cancel preview",
        verb: "key",
        outcome: "completed",
      },
      {
        seq: 5,
        owner: "main",
        phase: "undo",
        kind: "activation",
        label: "Undo",
        verb: "key",
        outcome: "completed",
      },
      {
        seq: 6,
        owner: "main",
        phase: "undo",
        kind: "request",
        requestId: 2,
        type: "UndoHistory",
        body: "{}",
      },
      {
        seq: 7,
        owner: "main",
        phase: "undo",
        kind: "response",
        requestId: 2,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      },
    ],
    before: start,
    after: definition.expected,
    failures: [],
    cancellations: [{ probe: "cancel", outcome: "completed", state: start }],
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
          { probe: "cancel", outcome: "completed", state: definition.expected },
          { probe: "cancel", outcome: "completed", state: start },
        ],
      }).reasons,
    ).toEqual([
      "cancellation cancel has 2 results",
      "canceled-cancel.clips.a.source_start expected 0, observed 0.3",
      "canceled-cancel.clips.a.timeline_start expected 0, observed 0.3",
    ]);
  });
  it("rejects ancillary app HTTP errors despite completed saved work", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      owner: "main",
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
        cancellations: [],
        undone: undefined,
      }).reasons,
    ).toEqual(["cancellation cancel has 0 results", "Undo not run"]);
  });
  it("retains unknown responses and duplicate mutations as failures", () => {
    const t = trial();
    t.journal.push({
      seq: 8,
      owner: "main",
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
      "cancellation cancel input not observed",
      "Undo input not observed",
      "Undo expected 1 UndoHistory commands, observed 0",
    ]);
  });
  it("rejects successful HTTP with an unknown command outcome", () => {
    const t = trial();
    t.journal[2] = {
      seq: 3,
      owner: "main",
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
        cancellation: [],
        undo: "none",
      },
    ],
  };
  const attempted: EditingTrial = {
    ...trial(),
    task: "seek",
    route: "ruler",
    cancellations: [],
    journal: [
      {
        seq: 1,
        owner: "main",
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
    owner: "main",
    phase: "setup",
    kind: "read-request",
    requestId: 3,
    url,
    method: "GET",
  });
  t.journal.push({
    seq: 9,
    owner: "main",
    phase: "setup",
    kind: "read-failed",
    requestId: 3,
    error: "net::ERR_ABORTED",
  });
  if (replaced) {
    t.journal.push({
      seq: 10,
      owner: "main",
      phase: "setup",
      kind: "read-request",
      requestId: 4,
      url,
      method: "GET",
    });
    t.journal.push({
      seq: 11,
      owner: "main",
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
        owner: "main",
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
        owner: "main",
        phase: "setup",
        kind: "request",
        requestId: 3,
        type: "Surprise",
        body: "{}",
      },
      {
        seq: 9,
        owner: "main",
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
      owner: "main",
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
      owner: "main",
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
        owner: "main",
        phase: "action",
        kind: "read-request",
        requestId: 8,
        url: "http://localhost/api/document/state?path=x&phase=detail",
        method: "GET",
      },
      {
        seq: 9,
        owner: "main",
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
      ...(phase === "cancel"
        ? { owner: "cancel" as const, probe: "cancel", phase }
        : { owner: "main" as const, phase }),
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
    owner: "main",
    phase: fault === "action" ? "action" : "setup",
    errorName: "Error",
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
    cancellations: [
      { probe: "cancel", outcome: "completed", state: task.start },
    ],
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
    cancellations: [],
    before: task.start,
    after: task.expected,
    undone: task.start,
  });
  t.journal = t.journal.filter((row) => row.owner !== "cancel");
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
    failures: [],
    cancellations: [],
    mode: "validity-only",
    before: task.start,
    after: task.expected,
    durationMs: 0,
    journal: [
      {
        seq: 1,
        owner: "main",
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

describe("owned phase oracle regressions", () => {
  it.each(["cancel", "undo"] as const)(
    "fails a failed %s activation without relabeling Save",
    (phase) => {
      const t = trial();
      const event = t.journal.find(
        (row) => row.kind === "activation" && row.phase === phase,
      )!;
      Object.assign(event, {
        outcome: "failed",
        error: "literal native input failure",
      });
      expect(assessEditingTrial(definition, t)).toMatchObject({
        status: "fail",
        completedWork: 0,
        observations:
          phase === "cancel"
            ? { save: "pass", cancel: "fail", undo: "pass" }
            : { save: "pass", cancel: "pass", undo: "fail" },
      });
    },
  );
  it.each(["http", "history"])(
    "fails Undo %s evidence without relabeling Save",
    (fault) => {
      const t = trial();
      if (fault === "http") Object.assign(t.journal[6], { status: 500 });
      else Object.assign(t.history!.undone!, { cursor: 1, headId: "changed" });
      expect(assessEditingTrial(definition, t)).toMatchObject({
        status: "fail",
        completedWork: 0,
        observations: { save: "pass", cancel: "pass", undo: "fail" },
      });
    },
  );
  it.each(["missing", "duplicate"])(
    "rejects %s named cancellation coverage",
    (fault) => {
      const t = trial();
      t.cancellations =
        fault === "missing"
          ? []
          : [
              { probe: "cancel", outcome: "completed", state: start },
              { probe: "cancel", outcome: "completed", state: start },
            ];
      expect(assessEditingTrial(definition, t)).toMatchObject({
        status: "fail",
        completedWork: 0,
        observations: { save: "pass", cancel: "fail", undo: "pass" },
      });
    },
  );
});

function threeProbeTrial() {
  const t = trial();
  t.cancellations = ["short", "vertical", "touch-cancel"].map((probe) => ({
    probe,
    outcome: "completed",
    state: start,
  }));
  t.journal = t.journal.filter((row) => row.owner !== "cancel");
  t.journal.push(
    ...["short", "vertical", "touch-cancel"].map((probe, index) => ({
      seq: 8 + index,
      owner: "cancel" as const,
      phase: "cancel" as const,
      probe,
      kind: "activation" as const,
      label: "literal independent clone",
      verb: "touch",
      outcome: "completed" as const,
    })),
  );
  const task: TaskDefinition = {
    ...definition,
    routes: [
      {
        id: "keyboard",
        input: "keyboard",
        command: "TrimClipEdge",
        mutations: 1,
        undo: "history",
        cancellation: [
          {
            id: "short",
            input: { kind: "comment-swipe", dx: 20, dy: 0, end: "touchEnd" },
          },
          {
            id: "vertical",
            input: { kind: "comment-swipe", dx: 64, dy: 30, end: "touchEnd" },
          },
          {
            id: "touch-cancel",
            input: { kind: "comment-swipe", dx: 64, dy: 0, end: "touchCancel" },
          },
        ],
      },
    ],
  };
  return { t, task };
}
it("admits all three independently completed named clones", () => {
  const { t, task } = threeProbeTrial();
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "pass",
    completedWork: 1,
    observations: { save: "pass", cancel: "pass", undo: "pass" },
  });
});
it.each([
  "empty",
  "missing",
  "duplicate",
  "unexpected",
  "unactivated",
  "started",
  "failed-result",
  "clone-setup",
])("rejects incomplete independent clones with %s evidence", (fault) => {
  const { t, task } = threeProbeTrial();
  if (fault === "empty") t.cancellations = [];
  if (fault === "missing") t.cancellations.pop();
  if (fault === "duplicate") t.cancellations[2] = t.cancellations[0];
  if (fault === "unexpected") t.cancellations[2].probe = "invented";
  if (fault === "unactivated")
    t.journal = t.journal.filter(
      (row) => row.owner !== "cancel" || row.probe !== "vertical",
    );
  if (fault === "started") Object.assign(t.journal[7], { outcome: "started" });
  if (fault === "failed-result")
    t.cancellations[0] = { probe: "short", outcome: "failed", state: start };
  if (fault === "clone-setup")
    t.failures.push({
      origin: { owner: "cancel", phase: "setup", probe: "short" },
      error: "literal clone setup failure",
      errorName: "Error",
    });
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
it("rejects earlier changed clone state despite a later restored clone", () => {
  const { t, task } = threeProbeTrial();
  t.cancellations[0].state = definition.expected;
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
it.each([
  "duration",
  "profiler",
  "trust",
  "main-setup",
  "save",
  "cancel-ui",
  "undo-ui",
])("projects %s failure through explicit prerequisites", (fault) => {
  const t = trial();
  if (fault === "duration") t.durationMs = NaN;
  if (fault === "profiler")
    t.failures.push({
      origin: { owner: "global", blocks: "admission" },
      error: "literal profiler failure",
      errorName: null,
    });
  if (fault === "trust")
    t.failures.push({
      origin: { owner: "global", blocks: "all-proofs" },
      error: "literal retention failure",
      errorName: null,
    });
  if (fault === "main-setup")
    t.failures.push({
      origin: { owner: "main", phase: "setup" },
      error: "literal setup failure",
      errorName: null,
    });
  if (fault === "save") t.after = start;
  if (fault === "cancel-ui")
    t.failures.push({
      origin: { owner: "cancel", phase: "cancel", probe: "cancel" },
      error: "literal UI value expected0 observed5",
      errorName: "Error",
    });
  if (fault === "undo-ui")
    t.failures.push({
      origin: { owner: "main", phase: "undo" },
      error: "literal UI failure",
      errorName: "Error",
    });
  const expected =
    fault === "trust"
      ? { save: "fail", cancel: "fail", undo: "fail" }
      : fault === "main-setup" || fault === "save"
        ? { save: "fail", cancel: "pass", undo: "fail" }
        : fault === "cancel-ui"
          ? { save: "pass", cancel: "fail", undo: "pass" }
          : fault === "undo-ui"
            ? { save: "pass", cancel: "pass", undo: "fail" }
            : { save: "pass", cancel: "pass", undo: "pass" };
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: expected,
  });
});
it("checks saved History even when Undo identity is invalid", () => {
  const t = trial();
  t.history!.undone = null;
  t.history!.after!.entries[1].operation = "wrong-operation";
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "pass", undo: "fail" },
  });
  t.history!.after!.entries[1].operation = "trim_clip_edge";
  expect(assessEditingTrial(definition, t).observations).toEqual({
    save: "pass",
    cancel: "pass",
    undo: "fail",
  });
});
it.each([201, 404, 503])(
  "treats unavailable command body HTTP%s as one fatal terminal without a mutation",
  (status) => {
    const t = trial();
    t.journal[2] = {
      seq: 3,
      owner: "main",
      phase: "action",
      kind: "command-body-failed",
      requestId: 1,
      status,
      error: "literal unavailable command body",
      errorName: null,
    };
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      mutations: 0,
      canceledReads: 0,
      observations: { save: "fail", cancel: "pass", undo: "fail" },
    });
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "command body 1 failed literal unavailable command body",
      "action expected 1 mutations, observed 0",
    ]);
  },
);
it.each(["duplicate", "mixed", "orphan", "owner", "order", "malformed"])(
  "rejects command body terminal %s",
  (fault) => {
    const t = trial();
    const terminal = {
      seq: 7,
      owner: "main" as const,
      phase: "undo" as const,
      kind: "command-body-failed" as const,
      requestId: 2,
      status: 201,
      error: "literal Undo body unavailable",
      errorName: "Error",
    };
    t.journal[6] = terminal;
    if (fault === "duplicate") t.journal.push({ ...terminal, seq: 8 });
    if (fault === "mixed")
      t.journal.push({
        seq: 8,
        owner: "main",
        phase: "undo",
        kind: "response",
        requestId: 2,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      });
    if (fault === "orphan") terminal.requestId = 999;
    if (fault === "owner")
      Object.assign(terminal, {
        owner: "cancel",
        phase: "cancel",
        probe: "cancel",
      });
    if (fault === "order") terminal.seq = 1;
    if (fault === "malformed")
      Object.assign(terminal, { errorName: undefined });
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations:
        fault === "orphan" || fault === "order" || fault === "malformed"
          ? { save: "fail", cancel: "fail", undo: "fail" }
          : fault === "owner"
            ? { save: "pass", cancel: "fail", undo: "fail" }
            : { save: "pass", cancel: "pass", undo: "fail" },
    });
  },
);
it.each([
  "missing-failures",
  "missing-results",
  "bad-global-owner",
  "bad-declaration",
])("rejects malformed current retained ownership %s", (fault) => {
  const t = trial(),
    task = structuredClone(definition);
  if (fault === "missing-failures") Object.assign(t, { failures: undefined });
  if (fault === "missing-results")
    Object.assign(t, { cancellations: undefined });
  if (fault === "bad-global-owner")
    t.failures.push({
      origin: {
        owner: "global",
        blocks: "admission",
        phase: "cancel",
      } as never,
      error: "cannot escape trust",
      errorName: null,
    });
  if (fault === "bad-declaration")
    Object.assign(task.routes[0], {
      cancellation: [
        { id: "cancel", input: { kind: "route-cancel" } },
        { id: "cancel", input: { kind: "route-cancel" } },
      ],
    });
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "fail", cancel: "fail", undo: "fail" },
  });
});
it("keeps missing unattempted proof distinct from an attempted missing snapshot", () => {
  const t = trial();
  t.cancellations = [];
  t.undone = undefined;
  t.journal = t.journal.filter((row) => row.phase === "action");
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "not-run", undo: "not-run" },
  });
  t.journal.push({
    seq: 8,
    owner: "cancel",
    phase: "cancel",
    probe: "cancel",
    kind: "activation",
    label: "cancel",
    verb: "key",
    outcome: "completed",
  });
  expect(assessEditingTrial(definition, t).observations).toEqual({
    save: "pass",
    cancel: "fail",
    undo: "not-run",
  });
});

it("requires a setup detail replacement from the same cancellation clone", () => {
  const { t, task } = threeProbeTrial();
  const url =
    "http://localhost/api/document/state?path=literal-project&phase=detail";
  t.journal.push(
    {
      seq: 11,
      owner: "cancel",
      phase: "setup",
      probe: "short",
      kind: "read-request",
      requestId: 20,
      method: "GET",
      url,
    },
    {
      seq: 12,
      owner: "cancel",
      phase: "setup",
      probe: "short",
      kind: "read-failed",
      requestId: 20,
      error: "net::ERR_ABORTED",
    },
    {
      seq: 13,
      owner: "cancel",
      phase: "setup",
      probe: "vertical",
      kind: "read-request",
      requestId: 21,
      method: "GET",
      url,
    },
    {
      seq: 14,
      owner: "cancel",
      phase: "setup",
      probe: "vertical",
      kind: "read-response",
      requestId: 21,
      status: 200,
      body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
    },
  );
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    canceledReads: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
  for (const row of t.journal)
    if (row.owner === "cancel" && row.seq >= 13) row.probe = "short";
  expect(assessEditingTrial(task, t)).toMatchObject({
    status: "pass",
    completedWork: 1,
    canceledReads: 1,
    observations: { save: "pass", cancel: "pass", undo: "pass" },
  });
});

it.each(["journal", "failure", "ui"])(
  "keeps unexpected syntactically valid probe %s evidence owned by Cancel",
  (source) => {
    const t = trial();
    const origin = {
      owner: "cancel" as const,
      phase: "cancel" as const,
      probe: "not-declared",
    };
    if (source === "journal") Object.assign(t.journal[3], origin);
    if (source === "failure")
      t.failures.push({
        origin,
        error: "literal undeclared clone failure",
        errorName: null,
      });
    if (source === "ui")
      t.uiEvidence = [
        { origin, stage: "literal unexpected clone", geometry: {} },
      ];
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations: { save: "pass", cancel: "fail", undo: "pass" },
    });
  },
);
it("keeps cancellation-wide context failures independent of valid main proof", () => {
  const t = trial();
  t.failures.push({
    origin: { owner: "cancel", phase: "cancel", probe: null },
    error: "literal context failure",
    errorName: "Error",
  });
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: { save: "pass", cancel: "fail", undo: "pass" },
  });
});
