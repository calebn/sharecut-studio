import { describe, expect, it, vi } from "vitest";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
} from "./transcriptReplace";

const options = { search: "Ada", replacement: "Mira", match_case: false };
describe("host-only find and replace", () => {
  it.each(["share:guest", "record:guest"])(
    "refuses %s preview and mutation without sending any request",
    async (key) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      await expect(previewTranscriptReplacement(key, options)).rejects.toThrow(
        "only available to the host",
      );
      await expect(
        replaceTranscriptMatches(key, options, "a".repeat(64)),
      ).rejects.toThrow("only available to the host");
      expect(fetch).not.toHaveBeenCalled();
      fetch.mockRestore();
    },
  );
});
