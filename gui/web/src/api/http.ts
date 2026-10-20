/**
 * The one place the frontend calls `fetch`. A project key says who is asking:
 * a host project path (session token in `X-Podcast-Token`), a `share:{token}`
 * review guest or a `record:{token}` recording guest (the token is in the URL
 * and the host token is never sent). Callers name the route for each audience
 * and never branch on the key themselves.
 */
import { authHeaders } from "../sessionAuth";
import { reviewApiBase, SHARE_PREFIX } from "../shareMode";
import { recordApiBase } from "../shareRoute";
import { ApiError, isAbortError, readApiFailure } from "../utils/apiError";

const RECORD_PREFIX = "record:";

/** The key for requests with no project: the host's own routes. */
export const HOST_KEY = "";

export const NETWORK_ERROR_CODE = "network_error";

/** A key for a recording guest, whose routes live under `/api/rec/{token}`. */
export function recordProjectKey(token: string): string {
  return `${RECORD_PREFIX}${token}`;
}

/**
 * `host` is the full path for the host. `guest` is the path under the token's
 * API base (`/api/review/{token}` or `/api/rec/{token}`). `url` is a
 * server-issued URL used as is (proxy chunk URLs already carry the token).
 */
export type ApiRoute =
  | { host: string; guest?: string }
  | { host?: undefined; guest: string }
  | { url: string };

type Audience =
  | { kind: "host" }
  | { kind: "guest"; base: (token: string) => string; token: string };

function audienceOf(projectKey: string): Audience {
  if (projectKey.startsWith(SHARE_PREFIX)) {
    return {
      kind: "guest",
      base: reviewApiBase,
      token: projectKey.slice(SHARE_PREFIX.length),
    };
  }
  if (projectKey.startsWith(RECORD_PREFIX)) {
    return {
      kind: "guest",
      base: recordApiBase,
      token: projectKey.slice(RECORD_PREFIX.length),
    };
  }
  return { kind: "host" };
}

function resolve(
  projectKey: string,
  route: ApiRoute,
  init: RequestInit | undefined,
): [string, RequestInit | undefined] {
  const audience = audienceOf(projectKey);
  if ("url" in route) {
    return audience.kind === "host"
      ? [route.url, { ...init, headers: authHeaders(init?.headers) }]
      : [route.url, init];
  }
  if (audience.kind === "host") {
    if (route.host === undefined) {
      throw new Error("This route is only available to share guests");
    }
    return [route.host, { ...init, headers: authHeaders(init?.headers) }];
  }
  if (route.guest === undefined) {
    throw new ApiError("This isn't available in a shared view.", null, null);
  }
  return [`${audience.base(audience.token)}${route.guest}`, init];
}

/** The response as the server sent it, ok or not. Transport errors are not mapped. */
export async function apiSend(
  projectKey: string,
  route: ApiRoute,
  init?: RequestInit,
): Promise<Response> {
  const [url, requestInit] = resolve(projectKey, route, init);
  return fetch(url, requestInit);
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "NetworkError")
  );
}

/**
 * A response that is ok. Anything else throws `ApiError` carrying the host
 * message, the `X-Sharecut-Error-Code` header and the status; an unreachable
 * server throws one with code `network_error` and no status. Aborts and
 * timeouts pass through unchanged.
 */
export async function apiFetch(
  projectKey: string,
  route: ApiRoute,
  init?: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await apiSend(projectKey, route, init);
  } catch (error) {
    if (isAbortError(error) || !isTransportFailure(error)) {
      throw error;
    }
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      NETWORK_ERROR_CODE,
    );
  }
  if (!res.ok) {
    throw await readApiFailure(res);
  }
  return res;
}
