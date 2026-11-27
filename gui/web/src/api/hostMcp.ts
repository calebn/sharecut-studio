import { withAbortTimeout } from "../utils/abortTimeout";
import { apiFetch, HOST_KEY } from "./http";

/** How long one activity read may take, body included, before it counts as a failed check. */
export const ACTIVITY_TIMEOUT_MS = 10_000;

/** What GET /api/host-mcp/activity says about the local host MCP address. */
export type HostMcpActivity = {
  /** False when this copy of Studio does not accept connections from other apps. */
  mounted: boolean;
  last_request_at: string | null;
  /** Seconds since the last successful request, or null when there has been none. */
  age_seconds: number | null;
};

/**
 * Read the activity report. A body that is not JSON (a proxy's HTML page) or has
 * the wrong shape throws: it is never a status the dialog could show.
 */
export function fetchHostMcpActivity(
  signal?: AbortSignal,
): Promise<HostMcpActivity> {
  return withAbortTimeout(
    ACTIVITY_TIMEOUT_MS,
    "The host didn't answer.",
    async (own) => {
      const res = await apiFetch(
        HOST_KEY,
        { host: "/api/host-mcp/activity" },
        { signal: own, cache: "no-store" },
      );
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null)
        throw new Error("bad shape");
      const { mounted, last_request_at, age_seconds } = body as Record<
        string,
        unknown
      >;
      if (typeof mounted !== "boolean") throw new Error("bad shape");
      if (
        age_seconds !== null &&
        (typeof age_seconds !== "number" ||
          !Number.isFinite(age_seconds) ||
          age_seconds < 0)
      ) {
        throw new Error("bad shape");
      }
      return {
        mounted,
        last_request_at:
          typeof last_request_at === "string" ? last_request_at : null,
        age_seconds: age_seconds ?? null,
      };
    },
    signal,
  );
}
