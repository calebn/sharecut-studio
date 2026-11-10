import { describe, expect, it, vi } from "vitest";
import { findMatches } from "../../../stages/edit/findMatches";
import { clipRow, minimalProject, sampleTrack } from "../../../test/fixtures";
import { scriptUtterance, scriptWord } from "../../../test/scriptHostKit";
import { matchCutOf } from "./findCut";
import { buildScriptModel } from "./scriptModel";

vi.mock("../../../edit/rangeSelection", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../edit/rangeSelection")>();
  return {
    ...actual,
    resolveSelectionRange: (
      ...args: Parameters<typeof actual.resolveSelectionRange>
    ) => {
      const resolution = actual.resolveSelectionRange(...args);
      return {
        ...resolution,
        targets: resolution.targets.map((target) => ({
          ...target,
          track_ids: ["ghost"],
        })),
      };
    },
  };
});

describe("matchCutOf skipped hits", () => {
  it("counts every hit of a group whose target cannot be made as skipped", () => {
    const utterances = [
      scriptUtterance("host", "Maya", [
        scriptWord("um", 0, 10),
        scriptWord("um", 1, 20),
        scriptWord("um", 2, 30),
      ]),
    ];
    const project = minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: {
        clip_count: 1,
        tracks: {
          host: [
            clipRow({
              id: "host-clip",
              track_id: "host",
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
    expect({
      targets: cut.targets,
      cut: cut.cut,
      skipped: cut.skipped,
    }).toEqual({ targets: [], cut: 0, skipped: 3 });
  });
});
