import { recordApiBase } from "../shareRoute";
import { readApiError } from "../utils/apiError";

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

export async function loadRecordBootstrap(
  token: string,
  signal?: AbortSignal,
): Promise<RecordBootstrap> {
  const res = await fetch(`${recordApiBase(token)}/bootstrap`, { signal });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<RecordBootstrap>;
}
