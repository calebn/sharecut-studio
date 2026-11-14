import { apiFetch, NETWORK_ERROR_CODE, recordProjectKey } from "../api/http";
import {
  ApiError,
  isAbortError,
  isPermanentRejection,
} from "../utils/apiError";

export type RecordBootstrap = {
  mode: "record";
  kind: "record";
  token: string;
  role: string | null;
  session_id: string | null;
  capabilities: string[];
  episode: { name: string };
  room: { recorded_cap: number; producer_cap: number };
  build: { capture: boolean; monitor: boolean; upload: boolean };
  expires_at: string | null;
};

/** Why `/rec/<token>` did not open. Carries no error text. */
export type BootFailure = "not-found" | "network" | "server";

export type BootOutcome =
  | { bootstrap: RecordBootstrap; failure: null }
  | { bootstrap: null; failure: BootFailure };

/** Rejects only on abort. Every other failure comes back as a `BootFailure`. */
export async function loadRecordBootstrap(
  token: string,
  signal?: AbortSignal,
): Promise<BootOutcome> {
  let res: Response;
  try {
    res = await apiFetch(
      recordProjectKey(token),
      { guest: "/bootstrap" },
      { signal },
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { bootstrap: null, failure: failureOf(error) };
  }
  try {
    return { bootstrap: (await res.json()) as RecordBootstrap, failure: null };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return { bootstrap: null, failure: "network" };
  }
}

function failureOf(error: unknown): BootFailure {
  if (error instanceof ApiError && error.code === NETWORK_ERROR_CODE) {
    return "network";
  }
  return isPermanentRejection(error) ? "not-found" : "server";
}
