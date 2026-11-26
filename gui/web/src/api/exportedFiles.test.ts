import { afterEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import {
  exportedArchiveHref,
  exportedFileHref,
  listExportedFiles,
  readGuestExportedFiles,
  revealExportedFile,
} from "./exportedFiles";
import { guestExportFailed, startGuestExport } from "./pipeline";

const ENTRY = {
  id: "clips/a b.wav",
  name: "a b.wav",
  kind: "audio",
  label: "Clip",
  bytes: 10,
  current: true,
};

const ARCHIVE = {
  name: "episode-export.zip",
  count: 1,
  bytes: 61,
  ticket: "1700000000.abc-1.sig",
};

function stubFetch(archive: unknown = undefined) {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ files: [ENTRY], archive }), {
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
    const href = exportedFileHref("/tmp/ep/episode.sharecut", {
      id: "clips/a b.wav",
      ticket: "1.2-3.sig",
    });
    expect(href).toContain("/api/export/files/clips/a%20b.wav?");
    expect(href).toContain(
      `path=${encodeURIComponent("/tmp/ep/episode.sharecut")}`,
    );
  });

  it("puts the listing's ticket in a host link and never the session token", () => {
    window.history.replaceState(null, "", "/?session_token=host-secret");
    const href = exportedFileHref("/tmp/ep/episode.sharecut", {
      id: "ep.mp3",
      ticket: "1700000000.12-34.abcdef",
    });
    window.history.replaceState(null, "", "/");
    expect(href).toContain("ticket=1700000000.12-34.abcdef");
    expect(href).not.toContain("host-secret");
    expect(href).not.toContain("token=host");
  });

  it("sends a guest through the review route with the token in the path", () => {
    const href = exportedFileHref(shareProjectKey("tok123"), {
      id: "clips/a.wav",
    });
    expect(href).toMatch(
      /\/api\/review\/tok123\/daw\/export\/files\/clips\/a\.wav$/,
    );
    expect(href).not.toContain("path=");
  });
});

describe("exportedArchiveHref", () => {
  it("carries the project path and the listing's ticket for the host, never the session token", () => {
    window.history.replaceState(null, "", "/?session_token=host-secret");
    const href = exportedArchiveHref("/tmp/ep/episode.sharecut", ARCHIVE);
    window.history.replaceState(null, "", "/");
    expect(href).toBe(
      `/api/export/archive?path=${encodeURIComponent("/tmp/ep/episode.sharecut")}&ticket=${encodeURIComponent(ARCHIVE.ticket)}`,
    );
    expect(href).not.toContain("host-secret");
  });

  it("sends a guest through the review route with the token in the path and no ticket", () => {
    expect(exportedArchiveHref(shareProjectKey("tok123"), {})).toMatch(
      /\/api\/review\/tok123\/daw\/export\/archive$/,
    );
  });
});

describe("listExportedFiles", () => {
  it("reads the host listing for the project path", async () => {
    const fetchMock = stubFetch();
    expect(await listExportedFiles("/tmp/ep/episode.sharecut")).toEqual({
      files: [ENTRY],
      archive: null,
    });
    expect(urlOf(fetchMock)).toContain("/api/export/files?path=");
    expect(urlOf(fetchMock)).toContain(
      encodeURIComponent("/tmp/ep/episode.sharecut"),
    );
  });

  it("reads the archive entry the server lists", async () => {
    stubFetch(ARCHIVE);
    expect(
      (await listExportedFiles("/tmp/ep/episode.sharecut")).archive,
    ).toEqual(ARCHIVE);
  });

  it("reads the Editor listing for a share key, with no host path", async () => {
    const fetchMock = stubFetch();
    await listExportedFiles(shareProjectKey("tok123"));
    expect(urlOf(fetchMock)).toMatch(
      /\/api\/review\/tok123\/daw\/export\/files$/,
    );
  });
});

describe("readGuestExportedFiles", () => {
  const guest = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
  const key = shareProjectKey("tok123");

  it("reads whether an export is running next to the listing", async () => {
    const signal = new AbortController().signal;
    guest({ revision: "r1", files: [ENTRY], exporting: true });
    expect(await readGuestExportedFiles(key, "", signal)).toMatchObject({
      revision: "r1",
      exporting: true,
    });
    guest({ revision: "r2", files: [ENTRY] });
    expect((await readGuestExportedFiles(key, "r1", signal)).exporting).toBe(
      false,
    );
  });

  it("leaves the flag unknown when only the matching revision came back", async () => {
    guest({ revision: "r1" });
    expect(
      await readGuestExportedFiles(key, "r1", new AbortController().signal),
    ).toEqual({
      inventory: null,
      revision: "r1",
      exporting: null,
      guestRender: null,
    });
  });

  it("reads whether the host allows exports from share links, unknown when absent", async () => {
    const signal = new AbortController().signal;
    guest({ revision: "r1", files: [ENTRY], guest_render: false });
    expect((await readGuestExportedFiles(key, "", signal)).guestRender).toBe(
      false,
    );
    guest({ revision: "r2", files: [ENTRY], guest_render: true });
    expect((await readGuestExportedFiles(key, "r1", signal)).guestRender).toBe(
      true,
    );
    guest({ revision: "r3", files: [ENTRY] });
    expect(
      (await readGuestExportedFiles(key, "r2", signal)).guestRender,
    ).toBeNull();
  });
});

describe("startGuestExport", () => {
  it("posts an empty JSON body to the share's export route so the host formats apply", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ job: { id: "j1" } }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await startGuestExport(shareProjectKey("tok123"));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/review/tok123/daw/export");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(init?.body).toBe("{}");
  });
});

describe("guestExportFailed", () => {
  const status = (job: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ running: false, job, jobs: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

  it("is true only when the newest export job ended in error", async () => {
    const key = shareProjectKey("tok123");
    status({ id: "j1", status: "error", error: "Export failed" });
    expect(await guestExportFailed(key)).toBe(true);
    status({ id: "j1", status: "done", error: null });
    expect(await guestExportFailed(key)).toBe(false);
    status(null);
    expect(await guestExportFailed(key)).toBe(false);
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
