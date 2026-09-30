import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { applyProjectionDelta, parseProjectionDelta } from "./projectionDelta";

function vector(name: string): {
  before: ProjectView;
  after: ProjectView;
  delta: unknown;
} {
  const value = JSON.parse(
    readFileSync(
      `${process.cwd()}/../../tests/fixtures/document_delta/${name}.json`,
      "utf8",
    ),
  );
  return {
    before: minimalProject(value.before),
    after: minimalProject(value.after),
    delta: value.delta,
  };
}
describe("closed projection deltas", () => {
  for (const name of ["small-move", "small-word", "small-regroup"])
    it(`reconstructs the real ${name} projection without mutating its predecessor`, () => {
      const { before, after, delta } = vector(name);
      const saved = structuredClone(before);
      const parsed = parseProjectionDelta(delta);
      const result = applyProjectionDelta(before, parsed);
      expect(result).toEqual(after);
      expect(before).toEqual(saved);
      if (name === "small-move") {
        expect(result.clips.tracks.host.find((row) => row.id === "c5")).toBe(
          before.clips.tracks.host.find((row) => row.id === "c5"),
        );
        expect(result.effects_by_track).toBe(before.effects_by_track);
      }
    });
  it("rejects unknown sections, dangerous keys, excessive work and invalid spans atomically", () => {
    const { before, delta } = vector("small-word");
    const bad = [
      {
        base_seq: 0,
        projection: "shell",
        audience: "host",
        operations: [{ type: "remove", section: "whatever", parent: null }],
      },
      JSON.parse(
        '{"base_seq":0,"projection":"shell","operations":[],"__proto__":{}}',
      ),
      { base_seq: -1, projection: "shell", audience: "host", operations: [] },
      {
        base_seq: 0,
        projection: "shell",
        audience: "host",
        operations: Array.from({ length: 4097 }, () => ({
          type: "remove",
          section: "comments",
          parent: null,
        })),
      },
    ];
    for (const value of bad)
      expect(() =>
        parseProjectionDelta({
          base_token: "a".repeat(64),
          audience: "host",
          ...value,
        }),
      ).toThrow();
    const parsed = parseProjectionDelta(delta);
    const rows = parsed.operations.find(
      (op) => op.type === "rows" && op.section === "utterances",
    );
    if (!rows || rows.type !== "rows") throw new Error("missing word edit");
    rows.before_count++;
    const saved = structuredClone(before);
    expect(() => applyProjectionDelta(before, parsed)).toThrow();
    expect(before).toEqual(saved);
  });
  it("requires the hydrated word predecessor", () => {
    const { before, delta } = vector("small-word");
    for (const row of before.transcript?.utterances ?? []) delete row.words;
    expect(() =>
      applyProjectionDelta(before, parseProjectionDelta(delta)),
    ).toThrow();
  });
  it("rejects duplicate section edits and bounded predecessor expansion atomically", () => {
    const header = {
      base_seq: 0,
      base_token: "a".repeat(64),
      projection: "detail",
      audience: "host",
    };
    const remove = { type: "remove", section: "utterances", parent: null };
    expect(() =>
      parseProjectionDelta({ ...header, operations: [remove, remove] }),
    ).toThrow();
    const { before } = vector("small-word");
    const utterance = before.transcript!.utterances[0];
    utterance.text = "x".repeat(100_000);
    const saved = structuredClone(before);
    const parsed = parseProjectionDelta({
      ...header,
      operations: [
        {
          type: "rows",
          section: "utterances",
          parent: null,
          before_count: before.transcript!.utterances.length,
          row_encoding: "predecessor-spans",
          splices: [
            {
              index: 0,
              delete: 0,
              insert: Array.from({ length: 100 }, () => ({
                header: {},
                text: { row: 0, index: 0, count: 1 },
              })),
            },
          ],
          updates: [],
        },
      ],
    });
    expect(() => applyProjectionDelta(before, parsed)).toThrow();
    expect(before).toEqual(saved);
  });
});
