import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostReach, useHostCause } from "../state/hostReach";
import { withAbortTimeout } from "../utils/abortTimeout";
import { ApiError } from "../utils/apiError";
import {
  apiFetch,
  apiSend,
  HOST_KEY,
  NETWORK_ERROR_CODE,
  recordProjectKey,
} from "./http";
import { markLinkEnded, subscribeLinkDoubt } from "./linkState";

vi.mock("../sessionAuth", () => ({
  authHeaders: (extra?: HeadersInit) => {
    const out: Record<string, string> = {};
    new Headers(extra).forEach((v, k) => {
      out[k] = v;
    });
    out["X-Podcast-Token"] = "host-secret";
    return out;
  },
}));

function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

beforeEach(() => stubFetch(async () => new Response("{}")));
afterEach(() => vi.unstubAllGlobals());

describe("apiFetch error mapping", () => {
  it("carries the code header, the status and the host message", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            detail: "This share was revoked. Ask the host for a new link.",
          }),
          {
            status: 403,
            headers: { "X-Sharecut-Error-Code": "share_revoked" },
          },
        ),
    );
    const error = await failure(apiFetch("share:t", { guest: "/project" }));
    expect({
      message: error.message,
      code: error.code,
      status: error.status,
    }).toEqual({
      message: "This share was revoked. Ask the host for a new link.",
      code: "share_revoked",
      status: 403,
    });
  });

  it("carries the model a host model_needed 409 names", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              detail: "Needs Whisper.",
              model: {
                id: "word-aligner",
                model: "wav2vec",
                label: "Word aligner",
                purpose: "Times words",
                size: "95 MB",
                size_bytes: 95_000_000,
                command: "podcast bootstrap",
                state: "missing",
              },
            },
          }),
          {
            status: 409,
            headers: { "X-Sharecut-Error-Code": "model_needed" },
          },
        ),
    );
    const error = await failure(apiFetch(HOST_KEY, { host: "/api/x" }));
    expect(error.model).toMatchObject({ id: "word-aligner", sizeBytes: 95e6 });
  });

  it("reads a nested FastAPI detail message", async () => {
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({ detail: { detail: "Pick a track first." } }),
          {
            status: 422,
          },
        ),
    );
    const error = await failure(apiFetch(HOST_KEY, { host: "/api/x" }));
    expect({ message: error.message, code: error.code }).toEqual({
      message: "Pick a track first.",
      code: null,
    });
  });

  it("falls back to the plain text of a non-JSON body", async () => {
    stubFetch(
      async () => new Response("upstream unavailable", { status: 502 }),
    );
    const error = await failure(apiFetch(HOST_KEY, { host: "/api/x" }));
    expect({
      message: error.message,
      code: error.code,
      status: error.status,
    }).toEqual({ message: "upstream unavailable", code: null, status: 502 });
  });

  it("names the status when the body is empty", async () => {
    stubFetch(async () => new Response("", { status: 500 }));
    const error = await failure(apiFetch(HOST_KEY, { host: "/api/x" }));
    expect(error.message).toBe("Request failed (500)");
  });

  it("maps an unreachable server to network_error with no status", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const error = await failure(apiFetch(HOST_KEY, { host: "/api/x" }));
    expect({
      message: error.message,
      code: error.code,
      status: error.status,
    }).toEqual({
      message:
        "Couldn't reach the server. Check your connection and try again.",
      code: NETWORK_ERROR_CODE,
      status: null,
    });
  });

  it("leaves an abort alone", async () => {
    stubFetch(async () => {
      throw new DOMException("Cancelled", "AbortError");
    });
    await expect(apiFetch(HOST_KEY, { host: "/api/x" })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("returns the response when ok", async () => {
    stubFetch(async () => new Response('{"a":1}', { status: 200 }));
    const res = await apiFetch(HOST_KEY, { host: "/api/x" });
    expect(await res.json()).toEqual({ a: 1 });
  });
});

describe("apiSend", () => {
  it("returns a refusal as is for callers that read the status", async () => {
    stubFetch(async () => new Response("gone", { status: 404 }));
    const res = await apiSend(HOST_KEY, { host: "/api/x" });
    expect(res.status).toBe(404);
  });
});

describe("share versus host auth", () => {
  it("sends the host token only to host routes", async () => {
    const spy = stubFetch(async () => new Response("{}"));
    await apiFetch("/tmp/ep.json", {
      host: "/api/project/meta?path=%2Ftmp%2Fep.json",
      guest: "/daw/meta",
    });
    await apiFetch("share:abc", { host: "/api/x", guest: "/daw/meta" });
    await apiFetch(recordProjectKey("abc"), { guest: "/bootstrap" });
    const sent = spy.mock.calls.map(([url, init]) => [
      url,
      new Headers(init?.headers).get("X-Podcast-Token"),
    ]);
    expect(sent).toEqual([
      ["/api/project/meta?path=%2Ftmp%2Fep.json", "host-secret"],
      ["/api/review/abc/daw/meta", null],
      ["/api/rec/abc/bootstrap", null],
    ]);
  });

  it("keeps the caller's headers next to the host token", async () => {
    const spy = stubFetch(async () => new Response("{}"));
    await apiFetch(
      HOST_KEY,
      { host: "/api/x" },
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect([
      headers.get("Content-Type"),
      headers.get("X-Podcast-Token"),
    ]).toEqual(["application/json", "host-secret"]);
  });

  it("sends a server-issued url as is, with the token only for the host", async () => {
    const spy = stubFetch(async () => new Response("{}"));
    await apiFetch("share:abc", { url: "/api/review/abc/daw/proxy/t/h/0" });
    await apiFetch(HOST_KEY, { url: "/api/audio?x=1" });
    expect(
      spy.mock.calls.map(([url, init]) => [
        url,
        new Headers(init?.headers).get("X-Podcast-Token"),
      ]),
    ).toEqual([
      ["/api/review/abc/daw/proxy/t/h/0", null],
      ["/api/audio?x=1", "host-secret"],
    ]);
  });

  it("refuses a host-only route for a share guest without calling the server", async () => {
    const spy = stubFetch(async () => new Response("{}"));
    const error = await failure(
      apiFetch("share:abc", { host: "/api/session/meta" }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(error.message).toBe("This isn't available in a shared view.");
  });
});

describe("apiSend and a link that may be off", () => {
  const DEAD = {
    status: 404,
    headers: { "X-Sharecut-Error-Code": "share_not_found" },
  };
  const doubts: string[] = [];
  let stop: () => void;
  beforeEach(() => {
    doubts.length = 0;
    stop = subscribeLinkDoubt((token) => doubts.push(token));
  });
  afterEach(() => stop());

  const guest = (token: string) => `share:${token}`;
  const route = { guest: "/project" };

  it("reports a coded 404 on a review share once and hands the response back unchanged", async () => {
    const answer = new Response(JSON.stringify({ detail: "gone" }), DEAD);
    stubFetch(async () => answer);
    const res = await apiSend(guest("tok-report"), route);
    expect(res).toBe(answer);
    expect(doubts).toEqual(["tok-report"]);
  });

  it("reports for a proxied chunk URL too, since the key picks the link", async () => {
    stubFetch(async () => new Response("{}", DEAD));
    await apiSend(guest("tok-chunk"), { url: "/api/review/tok-chunk/chunk" });
    expect(doubts).toEqual(["tok-chunk"]);
  });

  it.each([
    ["an uncoded 404", { status: 404 }],
    [
      "a 404 with another code",
      {
        status: 404,
        headers: { "X-Sharecut-Error-Code": "comment_not_found" },
      },
    ],
    [
      "a 403 with the dead-link code",
      { status: 403, headers: { "X-Sharecut-Error-Code": "share_not_found" } },
    ],
    ["a 500", { status: 500 }],
    ["a 502", { status: 502 }],
    [
      "a busy host",
      { status: 503, headers: { "X-Sharecut-Error-Code": "project_busy" } },
    ],
    ["a 429", { status: 429, headers: { "Retry-After": "5" } }],
    ["a 200", { status: 200 }],
  ])("does not report %s", async (_name, init) => {
    stubFetch(async () => new Response("{}", init));
    await apiSend(guest("tok-quiet"), route);
    expect(doubts).toEqual([]);
  });

  it.each([
    ["a lost connection", new TypeError("Failed to fetch")],
    ["an abort", new DOMException("aborted", "AbortError")],
    ["a timeout", new DOMException("slow", "TimeoutError")],
  ])(
    "does not report %s, and the failure passes through",
    async (_n, error) => {
      stubFetch(async () => {
        throw error;
      });
      await expect(apiSend(guest("tok-lost"), route)).rejects.toBe(error);
      expect(doubts).toEqual([]);
    },
  );

  it("never reports for a recording key or a host key, whatever they are answered", async () => {
    stubFetch(async () => new Response("{}", DEAD));
    await apiSend(recordProjectKey("tok-rec"), { guest: "/bootstrap" });
    await apiSend(HOST_KEY, { host: "/api/features" });
    await apiSend("/projects/episode.sharecut", {
      host: "/api/document/state",
    });
    expect(doubts).toEqual([]);
  });

  it("never refuses a request for a recording key or a host key, even for the same token text", async () => {
    markLinkEnded("tok-same");
    const spy = stubFetch(async () => new Response("{}"));
    await apiSend(recordProjectKey("tok-same"), { guest: "/bootstrap" });
    await apiSend(HOST_KEY, { host: "/api/features" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("starts no request for a link that ended: it fails as an abort, without calling fetch", async () => {
    markLinkEnded("tok-ended");
    const spy = stubFetch(async () => new Response("{}"));
    const error = await apiSend(guest("tok-ended"), route).catch((e) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads no header from an answer that is not a 404", async () => {
    const plain = { ok: true, status: 200, json: async () => ({}) };
    stubFetch(async () => plain as unknown as Response);
    await expect(apiSend(guest("tok-plain"), route)).resolves.toBe(plain);
    expect(doubts).toEqual([]);
  });

  it("leaves the host's own requests exactly as they were", async () => {
    const spy = stubFetch(async () => new Response("{}"));
    await apiSend(HOST_KEY, { host: "/api/features" });
    expect(spy).toHaveBeenCalledWith("/api/features", {
      headers: { "X-Podcast-Token": "host-secret" },
    });
  });
});

describe("apiSend and the host's reach", () => {
  const reach = (token: string) =>
    renderHook(() => useHostCause(token)).result.current;
  const refuse = () =>
    stubFetch(async () => Promise.reject(new TypeError("Failed to fetch")));
  const run = (key: string) =>
    apiSend(key, { guest: "/daw/meta" }).catch(() => undefined);

  beforeEach(() => {
    resetHostReach();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("is away after two transport failures of a review guest", async () => {
    refuse();
    await run("share:tok-r1");
    expect(reach("tok-r1")).toBeNull();
    await run("share:tok-r1");
    expect(reach("tok-r1")).toBe("host");
  });

  it("is away at once, for the device, when the browser says it is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    refuse();
    await run("share:tok-r2");
    expect(reach("tok-r2")).toBe("device");
  });

  it("counts a timeout, not an abort", async () => {
    stubFetch(async () => {
      throw new DOMException("The server didn't answer.", "TimeoutError");
    });
    await run("share:tok-r3");
    await run("share:tok-r3");
    expect(reach("tok-r3")).toBe("host");
    resetHostReach();
    stubFetch(async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    await run("share:tok-r3");
    await run("share:tok-r3");
    await run("share:tok-r3");
    expect(reach("tok-r3")).toBeNull();
  });

  it("counts a timeout that WebKit reports as a plain abort, not a user abort", async () => {
    const timedOut = async () =>
      withAbortTimeout(5, "slow", (signal) =>
        apiSend("share:tok-r8", { guest: "/x" }, { signal }),
      ).catch(() => undefined);
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Fetch is aborted", "AbortError")),
          );
        }),
    );
    await timedOut();
    await timedOut();
    expect(reach("tok-r8")).toBe("host");
    resetHostReach();
    const controller = new AbortController();
    stubFetch(async () => {
      controller.abort();
      throw new DOMException("Fetch is aborted", "AbortError");
    });
    for (let i = 0; i < 3; i += 1) {
      await apiSend(
        "share:tok-r8",
        { guest: "/x" },
        {
          signal: controller.signal,
        },
      ).catch(() => undefined);
    }
    expect(reach("tok-r8")).toBeNull();
  });

  it.each([
    ["a 502", { status: 502 }],
    ["a 504", { status: 504 }],
    ["a 503", { status: 503 }],
  ])("counts %s as no answer", async (_name, init) => {
    stubFetch(async () => new Response("{}", init));
    await run("share:tok-r9");
    expect(reach("tok-r9")).toBeNull();
    await run("share:tok-r9");
    expect(reach("tok-r9")).toBe("host");
  });

  it.each([
    ["a 500", { status: 500 }],
    ["a 403", { status: 403 }],
    ["a 429", { status: 429 }],
    [
      "a busy 503",
      { status: 503, headers: { "X-Sharecut-Error-Code": "project_busy" } },
    ],
  ])("treats %s as an answer", async (_name, init) => {
    refuse();
    await run("share:tok-r10");
    await run("share:tok-r10");
    expect(reach("tok-r10")).toBe("host");
    stubFetch(async () => new Response("{}", init));
    await run("share:tok-r10");
    expect(reach("tok-r10")).toBeNull();
  });

  it("counts two requests that fail together once", async () => {
    refuse();
    await Promise.all([run("share:tok-r11"), run("share:tok-r11")]);
    expect(reach("tok-r11")).toBeNull();
  });

  it("clears on any answer, a 5xx and a 404 included", async () => {
    refuse();
    await run("share:tok-r4");
    await run("share:tok-r4");
    expect(reach("tok-r4")).toBe("host");
    stubFetch(async () => new Response("{}", { status: 500 }));
    await run("share:tok-r4");
    expect(reach("tok-r4")).toBeNull();
    refuse();
    await run("share:tok-r4");
    await run("share:tok-r4");
    stubFetch(async () => new Response("{}", { status: 404 }));
    await run("share:tok-r4");
    expect(reach("tok-r4")).toBeNull();
  });

  it("never counts the host's own requests, a recording guest or a link that ended", async () => {
    refuse();
    for (let i = 0; i < 3; i += 1) {
      await run(HOST_KEY);
      await apiSend(recordProjectKey("tok-r5"), { guest: "/x" }).catch(() => 0);
    }
    expect(reach("tok-r5")).toBeNull();
    markLinkEnded("tok-r6");
    for (let i = 0; i < 3; i += 1) await run("share:tok-r6");
    expect(reach("tok-r6")).toBeNull();
  });

  it("rethrows the failure unchanged", async () => {
    const failure = new TypeError("Failed to fetch");
    stubFetch(async () => Promise.reject(failure));
    await expect(apiSend("share:tok-r7", { guest: "/x" })).rejects.toBe(
      failure,
    );
  });
});
