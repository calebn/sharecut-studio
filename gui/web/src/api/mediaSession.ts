import { hostFetch } from "../api/documentTransport";
import { getSessionToken } from "../sessionAuth";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import type {
  SessionMeta,
  SessionState,
  ViewerSessionSnapshot,
} from "../types/session";

export async function loadProxyManifest(
  projectPath: string,
): Promise<import("../audio/proxyMath").ProxyManifest | null> {
  if (!isShareProjectKey(projectPath)) {
    return null;
  }
  const token = shareTokenFromKey(projectPath);
  if (!token) {
    return null;
  }
  const res = await fetch(`${reviewApiBase(token)}/daw/proxy/manifest`);
  if (!res.ok) {
    return null;
  }
  return (await res.json()) as import("../audio/proxyMath").ProxyManifest;
}

export function audioUrl(
  projectPath: string,
  kind: "premix" | "stem" | "raw" | "processed" | "review",
  trackId?: string,
  opts?: {
    rerender?: boolean;
    cacheKey?: string;
  },
): string {
  if (isShareProjectKey(projectPath)) {
    const token = shareTokenFromKey(projectPath)!;
    const guestKind = kind === "raw" ? "premix" : kind;
    const params = new URLSearchParams({ kind: guestKind });
    if (trackId && (guestKind === "stem" || guestKind === "processed")) {
      params.set("track_id", trackId);
    }
    if (opts?.cacheKey) {
      params.set("v", opts.cacheKey);
    }
    return `${reviewApiBase(token)}/daw/audio?${params.toString()}`;
  }
  const params = new URLSearchParams({
    path: projectPath,
    kind,
  });
  if (trackId) {
    params.set("track_id", trackId);
  }
  if (opts?.rerender) {
    params.set("rerender", "true");
  }
  if (opts?.cacheKey) {
    params.set("v", opts.cacheKey);
  }
  const st = getSessionToken();
  if (st) {
    params.set("token", st);
  }
  return `/api/audio?${params.toString()}`;
}

export async function loadSessionMeta(
  projectPath: string,
): Promise<SessionMeta> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Session sync is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/session/meta?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionMeta>;
}

export async function loadSessionState(
  projectPath: string,
): Promise<SessionState | null> {
  if (isShareProjectKey(projectPath)) {
    return null;
  }
  const res = await hostFetch(
    `/api/session/state?path=${encodeURIComponent(projectPath)}`,
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionState>;
}

export async function postSessionState(
  projectPath: string,
  snapshot: ViewerSessionSnapshot,
): Promise<SessionState> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Session sync is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/session/state?path=${encodeURIComponent(projectPath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    },
  );
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<SessionState>;
}
