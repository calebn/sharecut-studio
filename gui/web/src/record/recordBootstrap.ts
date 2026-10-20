import { apiFetch, recordProjectKey } from "../api/http";

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
  const res = await apiFetch(
    recordProjectKey(token),
    { guest: "/bootstrap" },
    { signal },
  );
  return res.json() as Promise<RecordBootstrap>;
}
