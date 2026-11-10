import { describe, expect, it, vi } from "vitest";
import { findMatches } from "../../../stages/edit/findMatches";
import { clipRow, minimalProject, sampleTrack } from "../../../test/fixtures";
import { scriptUtterance, scriptWord } from "../../../test/scriptHostKit";
import { matchCutOf } from "./findCut";
import { buildScriptModel } from "./scriptModel";

vi.mock("../../../edit/rangeSelection", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../edit/rangeSelection")>();
  let calls = 0;
  return {
    ...actual,
    resolveSelectionRange: (
      ...args: Parameters<typeof actual.resolveSelectionRange>
    ) => {
      const resolution = actual.resolveSelectionRange(...args);
      const order = calls++ % 2 === 0 ? ["host", "guest"] : ["guest", "host"];
      return {
        ...resolution,
        targets: resolution.targets.map((target) => ({
          ...target,
          track_ids: order,
        })),
      };
    },
  };
});

describe("matchCutOf grouping", () => {
  it("groups hits on the same track set whatever order the tracks come in", () => {
    const utterances = [
      scriptUtterance("host", "Maya", [
        scriptWord("um", 0, 10),
        scriptWord("um", 1, 20),
      ]),
    ];
    const project = minimalProject({
      tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
      clips: {
        clip_count: 2,
        tracks: {
          host: [
            clipRow({
              id: "host-clip",
              track_id: "host",
              source_end: 60,
              timeline_end: 60,
            }),
          ],
          guest: [
            clipRow({
              id: "guest-clip",
              track_id: "guest",
              source_end: 60,
              timeline_end: 60,
            }),
          ],
        },
      },
      transcript: { utterances },
    });
    const model = buildScriptModel({
      utterances,
      boundaries: [],
      pending: [],
      person: () => ({ name: "x", colorIndex: 0 }),
    });
    const cut = matchCutOf(
      project,
      model,
      findMatches(model.turns, "um", false),
    );
    expect(cut.targets).toHaveLength(1);
    expect(cut.targets[0]?.track_ids).toEqual(["guest", "host"]);
    expect(cut.targets[0]?.intervals).toHaveLength(2);
  });
});
