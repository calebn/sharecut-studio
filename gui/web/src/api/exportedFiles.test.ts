import { afterEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import {
  exportedFileHref,
  listExportedFiles,
  revealExportedFile,
} from "./exportedFiles";

const ENTRY = {
  id: "clips/a b.wav",
  name: "a b.wav",
  kind: "audio",
  label: "Clip",
  bytes: 10,
  current: true,
};

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: [ENTRY] }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const urlOf = (fetchMock: ReturnType<typeof stubFetch>): string => {
  const target = fetchMock.mock.calls[0]?.[0];
  if (typeof target === "string") return target;
  if (target instanceof URL) return target.href;
  return target instanceof Request ? target.url : "";
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exportedFileHref", () => {
  it("keeps the folder in a host link and encodes each part of the name", () => {
    const href = exportedFileHref("/tmp/ep/episode.sharecut", "clips/a b.wav");
    expect(href).toContain("/api/export/files/clips/a%20b.wav?");
    expect(href).toContain(
      `path=${encodeURIComponent("/tmp/ep/episode.sharecut")}`,
    );
  });

  it("sends a guest through the review route with the token in the path", () => {
    const href = exportedFileHref(shareProjectKey("tok123"), "clips/a.wav");
    expect(href).toMatch(
      /\/api\/review\/tok123\/daw\/export\/files\/clips\/a\.wav$/,
    );
    expect(href).not.toContain("path=");
  });
});

describe("listExportedFiles", () => {
  it("reads the host listing for the project path", async () => {
    const fetchMock = stubFetch();
    expect(await listExportedFiles("/tmp/ep/episode.sharecut")).toEqual([
      ENTRY,
    ]);
    expect(urlOf(fetchMock)).toContain("/api/export/files?path=");
    expect(urlOf(fetchMock)).toContain(
      encodeURIComponent("/tmp/ep/episode.sharecut"),
    );
  });

  it("reads the Editor listing for a share key, with no host path", async () => {
    const fetchMock = stubFetch();
    await listExportedFiles(shareProjectKey("tok123"));
    expect(urlOf(fetchMock)).toMatch(
      /\/api\/review\/tok123\/daw\/export\/files$/,
    );
  });
});

describe("revealExportedFile", () => {
  it("posts the project path and the file id to the host", async () => {
    const fetchMock = stubFetch();
    await revealExportedFile("/tmp/ep/episode.sharecut", "ep.mp3");
    expect(urlOf(fetchMock)).toContain("/api/export/files/reveal");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual(
      {
        path: "/tmp/ep/episode.sharecut",
        id: "ep.mp3",
      },
    );
  });
});
