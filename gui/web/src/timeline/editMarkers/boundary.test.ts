import { describe, expect, it } from "vitest";
import { SRC_ROOT, sourceFiles } from "../../test/sourceFiles";

const DEEP_IMPORT =
  /from\s+["'][^"']*editMarkers\/(?:plan|EditMarkerLayer)["']/;

describe("editMarkers boundary", () => {
  it("is imported only through its index outside the folder", () => {
    const offenders = [...sourceFiles(SRC_ROOT)]
      .filter(({ rel }) => !rel.startsWith("timeline/editMarkers/"))
      .filter(({ text }) => DEEP_IMPORT.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
