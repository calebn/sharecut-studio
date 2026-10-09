import type { EditingTrial, TaskDefinition } from "./editingTaskReport";
import type { DurableState } from "./editingTaskState";

export const start: DurableState = {
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
export const definition: TaskDefinition = {
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
export function trial(): EditingTrial {
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
