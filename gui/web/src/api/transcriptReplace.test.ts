import { describe, expect, it, vi } from "vitest";
import {
  previewTranscriptReplacement,
  replaceTranscriptMatches,
} from "./transcriptReplace";

const submit = vi.hoisted(() => vi.fn());
vi.mock("./documentEdits", async (original) => ({
  ...(await original<typeof import("./documentEdits")>()),
  submitDocumentCommand: submit,
}));

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

describe("single match replace wire", () => {
  const sent = async (only?: number) => {
    submit.mockClear();
    await replaceTranscriptMatches("/tmp/ep", options, "a".repeat(64), only);
    return submit.mock.calls[0][2] as Record<string, unknown>;
  };

  it("sends only: 0 as a real position", async () => {
    expect(await sent(0)).toHaveProperty("only", 0);
  });

  it("omits only when it is undefined", async () => {
    expect(await sent(undefined)).not.toHaveProperty("only");
  });
});
