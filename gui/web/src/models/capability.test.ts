import { describe, expect, it } from "vitest";
import { IOS_WHISPER_CATALOG } from "../test/iosFixtures";
import { WHISPER_CATALOG } from "../test/renderWithModels";
import { WHISPER_SIZES, whisperSizeOptions } from "./capability";

describe("whisperSizeOptions", () => {
  it("keeps Fast, Balanced and Best on a desktop host", () => {
    expect(whisperSizeOptions([], "faster_whisper")).toEqual(WHISPER_SIZES);
    expect(
      whisperSizeOptions(WHISPER_CATALOG, "faster_whisper").map((o) => o.name),
    ).toEqual(["Fast", "Balanced", "Best"]);
  });

  it("takes a desktop size from the server when it lists one, without the tilde", () => {
    const options = whisperSizeOptions(WHISPER_CATALOG, "faster_whisper");
    expect(options.find((o) => o.id === "small.en")?.size).toBe("500 MB");
    expect(options.find((o) => o.id === "tiny.en")?.size).toBe("75 MB");
  });

  it("lists the host's own variants under the server's labels on whisper.cpp", () => {
    expect(whisperSizeOptions(IOS_WHISPER_CATALOG, "whisper_cpp")).toEqual([
      {
        id: "small.en-q5_1",
        name: "Recommended",
        size: "190 MB",
        description: IOS_WHISPER_CATALOG[0].description,
      },
      {
        id: "base.en-q5_1",
        name: "Less accurate",
        size: "60 MB",
        description: IOS_WHISPER_CATALOG[1].description,
      },
    ]);
  });

  it("lists nothing on whisper.cpp until the server lists variants", () => {
    expect(whisperSizeOptions([], "whisper_cpp")).toEqual([]);
  });
});
