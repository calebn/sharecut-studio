import { describe, expect, it } from "vitest";
import { sampleTrack } from "../../test/fixtures";
import { episodePeople, personId, withKnownPeople } from "./trackPeople";

describe("episodePeople", () => {
  it("lists each voice speaker once, in track order, with the Script's colours", () => {
    expect(
      episodePeople([
        sampleTrack({ id: "a", speaker: "Mira", role: "dialogue" }),
        sampleTrack({ id: "b", speaker: "Tomas", role: "dialogue" }),
        sampleTrack({ id: "c", speaker: "mira ", role: "dialogue" }),
        sampleTrack({ id: "d", speaker: "Theme", role: "music" }),
      ]),
    ).toEqual([
      { id: "mira", name: "Mira", colorIndex: 0 },
      { id: "tomas", name: "Tomas", colorIndex: 1 },
    ]);
  });

  it("skips empty speakers", () => {
    expect(
      episodePeople([
        sampleTrack({ id: "a", speaker: null, role: "dialogue" }),
        sampleTrack({ id: "b", speaker: "  ", role: "dialogue" }),
        sampleTrack({ id: "c", speaker: "Priya", role: "dialogue" }),
      ]),
    ).toEqual([{ id: "priya", name: "Priya", colorIndex: 2 }]);
  });
});

describe("personId", () => {
  it("trims and lower-cases", () => {
    expect(personId("  Mira Vale ")).toBe("mira vale");
    expect(personId(null)).toBe("");
  });
});

const mira = { id: "mira", name: "Mira", colorIndex: 0 };
const tomas = { id: "tomas", name: "Tomas", colorIndex: 1 };

describe("withKnownPeople", () => {
  it("lists the people on tracks first, then the known people without a track", () => {
    expect(withKnownPeople([tomas], [mira, tomas])).toEqual([tomas, mira]);
  });

  it("is the people on tracks when no one else is known", () => {
    expect(withKnownPeople([tomas], [])).toEqual([tomas]);
  });
});
