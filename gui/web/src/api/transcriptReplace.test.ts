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
const PREVIEW = {
  matches: [],
  count: 0,
  skipped_words: 0,
  preview_token: "a".repeat(64),
};

const answer = () =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(PREVIEW), {
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("find and replace by audience", () => {
  it("refuses a recording guest's preview and mutation without sending any request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      previewTranscriptReplacement("record:guest", options),
    ).rejects.toThrow("only available to the host");
    await expect(
      replaceTranscriptMatches("record:guest", options, "a".repeat(64)),
    ).rejects.toThrow("only available to the host");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("previews a share link's find on the link's own route with only the search fields", async () => {
    const fetch = answer();
    expect(await previewTranscriptReplacement("share:guest", options)).toEqual(
      PREVIEW,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/review/guest/daw/transcript/replacement-preview");
    expect(JSON.parse(init?.body as string)).toEqual(options);
    fetch.mockRestore();
  });

  it("previews the host's find on the host route with the project path", async () => {
    const fetch = answer();
    await previewTranscriptReplacement("/tmp/ep", options);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/transcript/replacement-preview");
    expect(JSON.parse(init?.body as string)).toEqual({
      path: "/tmp/ep",
      ...options,
    });
    fetch.mockRestore();
  });

  it("sends a share link's replacement as a document command", async () => {
    submit.mockClear();
    await replaceTranscriptMatches("share:guest", options, "a".repeat(64), 0);
    expect(submit.mock.calls[0]![0]).toBe("share:guest");
    expect(submit.mock.calls[0]![2]).toEqual({
      ...options,
      preview_token: "a".repeat(64),
      only: 0,
    });
  });
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
