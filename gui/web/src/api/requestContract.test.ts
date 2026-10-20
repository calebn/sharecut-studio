import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedFetchArrayBuffer } from "../audio/chunkCache";
import { loadRecordBootstrap } from "../record/recordBootstrap";
import { guestRecordUploadTransport } from "../record/upload/http";
import {
  addCommentReply,
  createComment,
  setCommentActionDone,
} from "./comments";
import { postGuestDocumentCommand } from "./documentTransport";
import { loadProxyManifest, loadSessionMeta } from "./mediaSession";
import { loadPipelineSteps, startRenderPreview } from "./pipeline";
import {
  createEpisodeProject,
  loadDocumentState,
  loadProjectMeta,
  loadReviewBootstrap,
  uploadMediaFile,
} from "./project";
import { loadWaveformSnap, loadWaveformStatus } from "./waveform";

vi.mock("../sessionAuth", () => ({
  getSessionToken: () => "host-secret",
  authHeaders: (extra?: HeadersInit) => {
    const out: Record<string, string> = {};
    new Headers(extra).forEach((v, k) => {
      out[k] = v;
    });
    out["X-Podcast-Token"] = "host-secret";
    return out;
  },
}));

type Seen = { url: string; method: string; token: string | null };

let seen: Seen[];

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({
        url: input,
        method: init?.method ?? "GET",
        token: new Headers(init?.headers).get("X-Podcast-Token"),
      });
      return respond({
        server_seq: 1,
        state_token: "a".repeat(64),
        complete: true,
        rel_path: "a.wav",
        mtime_ns: 1,
        size: 2,
        comment: { id: "c1" },
        job: { id: "j1", status: "ok", error: null },
        segments: [],
        steps: [],
        media: {},
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const HOST = "/tmp/ep one.project.json";
const GUEST = "share:tok/1";

describe("host requests carry the session token", () => {
  it("sends X-Podcast-Token on every host route", async () => {
    await loadPipelineSteps();
    await loadProjectMeta(HOST);
    await createEpisodeProject("/ws", "Ep");
    await loadDocumentState(HOST, "full");
    await uploadMediaFile(HOST, new File(["x"], "a.wav"));
    await loadWaveformStatus(HOST, "raw");
    await loadWaveformSnap(HOST, "t1", 1, 2);
    expect(seen).toEqual([
      { url: "/api/pipeline/steps", method: "GET", token: "host-secret" },
      {
        url: "/api/project/meta?path=%2Ftmp%2Fep%20one.project.json",
        method: "GET",
        token: "host-secret",
      },
      { url: "/api/project/create", method: "POST", token: "host-secret" },
      {
        url: "/api/document/state?path=%2Ftmp%2Fep%20one.project.json&phase=full",
        method: "GET",
        token: "host-secret",
      },
      {
        url: "/api/media/upload?filename=a.wav&chunk_index=0&total_chunks=1&path=%2Ftmp%2Fep+one.project.json",
        method: "POST",
        token: "host-secret",
      },
      {
        url: "/api/waveform/status?path=%2Ftmp%2Fep+one.project.json&kind=raw",
        method: "GET",
        token: "host-secret",
      },
      {
        url: "/api/waveform-snap?path=%2Ftmp%2Fep+one.project.json&track_id=t1&start=1&end=2&timeline=false",
        method: "GET",
        token: "host-secret",
      },
    ]);
  });
});

describe("share guest requests go to the review base without the host token", () => {
  it("routes every guest call under /api/review/<token>", async () => {
    await loadReviewBootstrap("tok/1");
    await loadProjectMeta(GUEST);
    await loadDocumentState(GUEST);
    await loadProxyManifest(GUEST);
    await createComment(GUEST, {
      body: "b",
      author: "a",
      timelineStart: 1,
    });
    await setCommentActionDone(GUEST, "c 1", "a 1", { done: true, by: "g" });
    await addCommentReply(GUEST, "c 1", { body: "r", author: "g" });
    await uploadMediaFile(GUEST, new File(["x"], "a.wav"));
    await startRenderPreview(GUEST);
    await loadWaveformStatus(GUEST, "raw");
    await loadWaveformSnap(GUEST, "t1", 1, 2);
    await postGuestDocumentCommand("tok/1", { type: "Noop" });
    expect(seen).toEqual([
      { url: "/api/review/tok%2F1/project", method: "GET", token: null },
      { url: "/api/review/tok%2F1/daw/meta", method: "GET", token: null },
      {
        url: "/api/review/tok%2F1/daw/document/state?phase=shell",
        method: "GET",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/proxy/manifest",
        method: "GET",
        token: null,
      },
      { url: "/api/review/tok%2F1/comments", method: "POST", token: null },
      {
        url: "/api/review/tok%2F1/comments/c%201/actions/a%201/done",
        method: "POST",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/comments/c%201/replies",
        method: "POST",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/media/upload?filename=a.wav&chunk_index=0&total_chunks=1",
        method: "POST",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/render-preview",
        method: "POST",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/render-preview/j1",
        method: "GET",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/waveform/status",
        method: "GET",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/waveform-snap?track_id=t1&start=1&end=2&timeline=false",
        method: "GET",
        token: null,
      },
      {
        url: "/api/review/tok%2F1/daw/document/command",
        method: "POST",
        token: null,
      },
    ]);
  });
});

describe("record guest requests use the record base and lease headers", () => {
  it("sends participant and lease, never the host token", async () => {
    const headers: Array<[string | null, string | null]> = [];
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({
          url: input,
          method: init?.method ?? "GET",
          token: h.get("X-Podcast-Token"),
        });
        headers.push([h.get("X-Record-Participant"), h.get("X-Record-Lease")]);
        return respond({ segments: [], acked: true });
      },
    );
    await loadRecordBootstrap("tok/1");
    const upload = guestRecordUploadTransport("tok/1", "p1", "l1");
    await upload.status();
    await upload.revokeRoomTone?.();
    expect(seen).toEqual([
      { url: "/api/rec/tok%2F1/bootstrap", method: "GET", token: null },
      { url: "/api/rec/tok%2F1/upload", method: "GET", token: null },
      {
        url: "/api/rec/tok%2F1/upload?kind=room_tone",
        method: "DELETE",
        token: null,
      },
    ]);
    expect(headers).toEqual([
      [null, null],
      ["p1", "l1"],
      ["p1", "l1"],
    ]);
  });
});

describe("proxy chunks", () => {
  it("fetch the server-issued url as given", async () => {
    vi.stubGlobal("caches", undefined);
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: string, init?: RequestInit) => {
        seen.push({
          url: input,
          method: init?.method ?? "GET",
          token: new Headers(init?.headers).get("X-Podcast-Token"),
        });
        return new Response(new Uint8Array([1, 2]));
      },
    );
    const buf = await cachedFetchArrayBuffer(
      "share:tok",
      "/api/review/tok/daw/proxy/t/h/0",
    );
    expect(buf.byteLength).toBe(2);
    expect(seen).toEqual([
      { url: "/api/review/tok/daw/proxy/t/h/0", method: "GET", token: null },
    ]);
  });
});

describe("refusals keep the host message and code", () => {
  it.each([
    [
      "a guest comment",
      () => createComment(GUEST, { body: "b", author: "a", timelineStart: 1 }),
    ],
    ["host project meta", () => loadProjectMeta(HOST)],
    ["host session meta", () => loadSessionMeta(HOST)],
    ["host pipeline steps", () => loadPipelineSteps()],
  ])("%s", async (_name, call) => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            detail: "This share is read-only. Ask the host for edit access.",
          }),
          {
            status: 403,
            headers: { "X-Sharecut-Error-Code": "share_read_only" },
          },
        ),
    );
    await expect(call()).rejects.toMatchObject({
      name: "ApiError",
      message: "This share is read-only. Ask the host for edit access.",
      code: "share_read_only",
      status: 403,
    });
  });
});
