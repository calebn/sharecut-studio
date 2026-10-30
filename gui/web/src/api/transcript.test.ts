import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportTranscript, listExportedTranscripts } from "./transcript";

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

  it("lists the exported files for an encoded path", async () => {
    await listExportedTranscripts("/p q/episode.sharecut");
    expect(apiFetch.mock.calls[0][1]).toEqual({
      host: "/api/transcript/exports?path=%2Fp%20q%2Fepisode.sharecut",
    });
  });
});
