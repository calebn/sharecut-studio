/** Session token for host GUI when PODCAST_SESSION_AUTHZ=strict (LAN bind). */

let _cached: string | null | undefined;

export function sessionTokenFromQuery(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("session_token");
}

export function getSessionToken(): string | null {
  if (_cached !== undefined) {
    return _cached;
  }
  _cached = sessionTokenFromQuery();
  return _cached;
}

export function authHeaders(extra?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (extra) {
    const h = new Headers(extra);
    h.forEach((v, k) => {
      out[k] = v;
    });
  }
  const tok = getSessionToken();
  if (tok) {
    out["X-Podcast-Token"] = tok;
  }
  return out;
}

/** Append session_token query for WebSocket URLs when present. */
export function withSessionTokenQuery(url: string): string {
  const tok = getSessionToken();
  if (!tok) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(tok)}`;
}
