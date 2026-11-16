import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDocumentState, UnusableAnswerError } from "./project";

vi.mock("../sessionAuth", () => ({
  authHeaders: (extra?: HeadersInit) => new Headers(extra),
}));

const DIGEST = "a".repeat(64);

function answer(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body))),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("loadDocumentState", () => {
  it("returns an answer that has a sequence and a basis", async () => {
    answer({ server_seq: 3, state_token: DIGEST });
    await expect(loadDocumentState("/tmp/ep.sharecut")).resolves.toMatchObject({
      server_seq: 3,
    });
  });

  it.each([
    ["a body that is not a document", null],
    ["a body with no sequence", { state_token: DIGEST }],
    ["a negative sequence", { server_seq: -1, state_token: DIGEST }],
    ["a body with no basis", { server_seq: 1 }],
    ["a basis that is not a digest", { server_seq: 1, state_token: "x" }],
  ])("throws an UnusableAnswerError for %s", async (_name, body) => {
    answer(body);
    await expect(loadDocumentState("/tmp/ep.sharecut")).rejects.toBeInstanceOf(
      UnusableAnswerError,
    );
  });
});
