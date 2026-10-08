import { describe, expect, it } from "vitest";
import {
  assessEditingTrial,
  type DurableState,
  type EditingTrial,
  type TaskDefinition,
} from "./editingTaskReport";

const start: DurableState = {
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
  tracks: [{ id: "reference", fader_db: 0, muted: false }],
  envelopes: [],
  comments: [],
};
const definition: TaskDefinition = {
  id: "trim",
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
    });
  });
  it("rejects unchanged state despite correct outgoing target", () => {
    expect(
      assessEditingTrial(definition, { ...trial(), after: start }).reasons,
    ).toEqual([
      "after.clips.0.source_start expected 0.3, observed 0",
      "after.clips.0.timeline_start expected 0.3, observed 0",
      "task made no saved change",
    ]);
  });
  it("rejects unrelated saved changes", () => {
    expect(
      assessEditingTrial(definition, {
        ...trial(),
        after: {
          ...definition.expected,
          tracks: [{ id: "reference", fader_db: -6, muted: false }],
        },
      }).reasons,
    ).toEqual(["after.tracks.0.fader_db expected 0, observed -6"]);
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
