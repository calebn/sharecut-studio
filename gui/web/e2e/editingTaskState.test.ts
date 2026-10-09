import { expect, it } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import {
  assessEditingTrial,
  type EditingTrial,
  type TaskDefinition,
} from "./editingTaskReport";
import { savedStateDifferences } from "./editingTaskState";
import { definition, start, trial } from "./editingTaskTestFixtures";

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
