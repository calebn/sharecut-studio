import { describe, expect, it } from "vitest";
import { findMatches } from "../../../stages/edit/findMatches";
import { clipRow, minimalProject, sampleTrack } from "../../../test/fixtures";
import { scriptUtterance, scriptWord } from "../../../test/scriptHostKit";
import type { CombinedUtterance, ProjectView } from "../../../types/project";
import { cutAllMessage, matchCutOf } from "./findCut";
import { buildScriptModel } from "./scriptModel";

const person = (trackId: string) => ({
  name: trackId,
  colorIndex: trackId === "host" ? 0 : 1,
});

function setup(utterances: CombinedUtterance[], query: string, length = 60) {
  const project: ProjectView = minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      clip_count: 2,
      tracks: {
        host: [
          clipRow({
            id: "host-clip",
            track_id: "host",
            source_end: length,
            timeline_end: length,
          }),
        ],
        guest: [
          clipRow({
            id: "guest-clip",
            track_id: "guest",
            source_end: length,
            timeline_end: length,
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
    person,
  });
  return { project, model, hits: findMatches(model.turns, query, false) };
}

const spans = (cut: ReturnType<typeof matchCutOf>) =>
  cut.targets.map((t) => [t.track_ids, t.intervals]);

describe("matchCutOf", () => {
  it("gives each speaker their own target when the speakers overlap", () => {
    const { project, model, hits } = setup(
      [
        scriptUtterance("host", "Maya", [
          scriptWord("um", 0, 10),
          scriptWord("um", 1, 20),
        ]),
        scriptUtterance("guest", "Anneke", [
          scriptWord("um", 0, 10.2),
          scriptWord("um", 1, 30),
        ]),
      ],
      "um",
    );
    const cut = matchCutOf(project, model, hits);
    expect({ cut: cut.cut, skipped: cut.skipped, spans: spans(cut) }).toEqual({
      cut: 4,
      skipped: 0,
      spans: [
        [
          ["host"],
          [
            { start: 10, end: 10.4 },
            { start: 20, end: 20.4 },
          ],
        ],
        [
          ["guest"],
          [
            { start: 10.2, end: 10.6 },
            { start: 30, end: 30.4 },
          ],
        ],
      ],
    });
  });

  it("cuts an interrupted phrase on the speaker's track and leaves the other speaker out", () => {
    const { project, model, hits } = setup(
      [
        scriptUtterance("host", "Maya", [scriptWord("one", 0, 10)]),
        scriptUtterance("guest", "Anneke", [scriptWord("yes", 0, 12)]),
        scriptUtterance("host", "Maya", [scriptWord("thanks", 1, 14)]),
      ],
      "one thanks",
    );
    expect(spans(matchCutOf(project, model, hits))).toEqual([
      [["host"], [{ start: 10, end: 14.4 }]],
    ]);
  });

  it("merges hits that touch into one interval", () => {
    const { project, model, hits } = setup(
      [
        scriptUtterance("host", "Maya", [
          scriptWord("no", 0, 10),
          scriptWord("no", 1, 10.4),
          scriptWord("no", 2, 12),
        ]),
      ],
      "no",
    );
    expect(spans(matchCutOf(project, model, hits))).toEqual([
      [
        ["host"],
        [
          { start: 10, end: 10.8 },
          { start: 12, end: 12.4 },
        ],
      ],
    ]);
  });

  it("counts a hit with no audible placement as skipped and cuts the rest", () => {
    const { project, model, hits } = setup(
      [
        scriptUtterance("host", "Maya", [
          scriptWord("um", 0, 10),
          scriptWord("um", 1, 20, { mappable: false }),
        ]),
      ],
      "um",
    );
    const cut = matchCutOf(project, model, hits);
    expect({ cut: cut.cut, skipped: cut.skipped, spans: spans(cut) }).toEqual({
      cut: 1,
      skipped: 1,
      spans: [[["host"], [{ start: 10, end: 10.4 }]]],
    });
  });

  it("counts hits on a track the project no longer has as skipped, not cut", () => {
    const { project, model, hits } = setup(
      [
        scriptUtterance("host", "Maya", [scriptWord("um", 0, 10)]),
        scriptUtterance("guest", "Anneke", [
          scriptWord("um", 0, 20),
          scriptWord("um", 1, 30),
        ]),
      ],
      "um",
    );
    const dropped = {
      ...project,
      tracks: project.tracks.filter((track) => track.id !== "guest"),
    };
    const cut = matchCutOf(dropped, model, hits);
    expect({ cut: cut.cut, skipped: cut.skipped, spans: spans(cut) }).toEqual({
      cut: 1,
      skipped: 2,
      spans: [[["host"], [{ start: 10, end: 10.4 }]]],
    });
  });

  it("refuses more targets than the server takes in one command", () => {
    const ids = Array.from({ length: 65 }, (_, i) => `t${i}`);
    const utterances = ids.map((id, i) =>
      scriptUtterance(id, id, [scriptWord("um", 0, i * 2)]),
    );
    const project: ProjectView = minimalProject({
      tracks: ids.map((id) => sampleTrack({ id })),
      clips: {
        clip_count: 65,
        tracks: Object.fromEntries(
          ids.map((id) => [
            id,
            [
              clipRow({
                id: `${id}-clip`,
                track_id: id,
                source_end: 200,
                timeline_end: 200,
              }),
            ],
          ]),
        ),
      },
      transcript: { utterances },
    });
    const model = buildScriptModel({
      utterances,
      boundaries: [],
      pending: [],
      person: () => ({ name: "x", colorIndex: 0 }),
    });
    expect(() =>
      matchCutOf(project, model, findMatches(model.turns, "um", false)),
    ).toThrow(
      "These matches are spread over too many tracks to cut at once. Narrow the search.",
    );
  });

  it("refuses more intervals than the server takes in one target", () => {
    const words = Array.from({ length: 1001 }, (_, i) =>
      scriptWord("um", i, i * 2),
    );
    const { project, model, hits } = setup(
      [scriptUtterance("host", "Maya", words)],
      "um",
      3000,
    );
    expect(() => matchCutOf(project, model, hits)).toThrow(
      "Too many matches to cut at once. Narrow the search.",
    );
  });
});

describe("cutAllMessage", () => {
  it("counts matches and names the ones left", () => {
    expect([
      cutAllMessage(1, 0),
      cutAllMessage(12, 0),
      cutAllMessage(10, 2),
    ]).toEqual([
      "Cut 1 match",
      "Cut 12 matches",
      "Cut 10 of 12 matches. 2 could not be placed. Cut those in the timeline.",
    ]);
  });
});
