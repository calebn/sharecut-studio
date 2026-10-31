import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportTranscript } from "./transcript";

const apiFetch = vi.fn();
vi.mock("./http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http")>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe("transcript api", () => {
  beforeEach(() => {
    apiFetch.mockReset().mockResolvedValue({ json: async () => ({}) });
  });

  it("posts the project path with the formats and flags", async () => {
    await exportTranscript("/p/episode.sharecut", {
      formats: ["md"],
      dry_run: true,
      with_text: true,
    });
    const [, target, init] = apiFetch.mock.calls[0];
    expect(target).toEqual({ host: "/api/transcript/export" });
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      path: "/p/episode.sharecut",
      formats: ["md"],
      dry_run: true,
      with_text: true,
    });
  });
});
