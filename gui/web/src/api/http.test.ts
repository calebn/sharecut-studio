import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import {
  apiFetch,
  apiSend,
  HOST_KEY,
  NETWORK_ERROR_CODE,
  recordProjectKey,
} from "./http";

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
