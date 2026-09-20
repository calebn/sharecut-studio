/** Sharecut Studio Extensions — feature manifest from GET /api/features (absent = no render). */

import { parseShareRoute, recordApiBase, reviewApiBase } from "../shareRoute";

export type FeaturesManifest = {
  api_version: number;
  features: string[];
};

const EMPTY: FeaturesManifest = { api_version: 1, features: [] };

/** Stable feature ids mirrored from podcast_mcp.extensions.features */
export const FEATURE_SHARE_UI_MENU = "share.ui.menu";
export const FEATURE_SHARE_UI_BANNER = "share.ui.banner";
export const FEATURE_SHARE_UI_ROUTES = "share.ui.routes";
export const FEATURE_EXTENSION_STATUS_0 = "extension.status.0";

/**
 * Guest share pages load under `/r/{token}` or `/rec/{token}` via the relay.
 * Relays only proxy those prefixes plus `/api/review/{token}/…` and
 * `/api/rec/{token}/…`, not host `/api/features`, so guests must not gate on
 * that host-only endpoint. The share HTML route is only mounted when the host
 * has `share.ui.routes`, so these caps are safe defaults.
 */
const GUEST_SHARE_FEATURES: FeaturesManifest = {
  api_version: 1,
  features: [
    FEATURE_SHARE_UI_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_EXTENSION_STATUS_0,
  ],
};

let cached: FeaturesManifest | null = null;
let inflight: Promise<FeaturesManifest> | null = null;

export function resetFeaturesCache(): void {
  cached = null;
  inflight = null;
}

/** Last successful features fetch, or null before the first cache write. */
export function peekCachedFeatures(): FeaturesManifest | null {
  return cached;
}

export function reviewTokenFromPathname(
  pathname: string = typeof window !== "undefined"
    ? window.location.pathname
    : "",
): string | null {
  const route = parseShareRoute(pathname);
  return route?.kind === "review" ? route.token : null;
}

export async function fetchFeatures(
  fetcher: typeof fetch = fetch,
  pathname?: string,
): Promise<FeaturesManifest> {
  if (cached) {
    return cached;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const route = parseShareRoute(
        pathname ??
          (typeof window !== "undefined" ? window.location.pathname : ""),
      );
      if (route) {
        // Prefer share-scoped features when the host exposes them; fall back to
        // guest defaults so relay guests are not stuck on a 404 /api/features.
        try {
          const featuresUrl =
            route.kind === "record"
              ? `${recordApiBase(route.token)}/features`
              : `${reviewApiBase(route.token)}/features`;
          const scoped = await fetcher(featuresUrl);
          if (scoped.ok) {
            const data = (await scoped.json()) as FeaturesManifest;
            cached = {
              api_version: Number(data.api_version) || 1,
              features: Array.isArray(data.features)
                ? data.features.map(String)
                : [],
            };
            return cached;
          }
        } catch {
          // ignore and use guest defaults
        }
        cached = GUEST_SHARE_FEATURES;
        return cached;
      }
      const res = await fetcher("/api/features");
      if (!res.ok) {
        // Transient failure — do not cache empty or guests stick on "extension not loaded".
        return EMPTY;
      }
      const data = (await res.json()) as FeaturesManifest;
      cached = {
        api_version: Number(data.api_version) || 1,
        features: Array.isArray(data.features) ? data.features.map(String) : [],
      };
      return cached;
    } catch {
      return EMPTY;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function hasFeature(
  manifest: FeaturesManifest | null | undefined,
  id: string,
): boolean {
  return Boolean(manifest?.features.includes(id));
}
