import type { TunnelStatus } from "../types/tunnel";
import { readApiError } from "../utils/apiError";
import { hostFetch } from "./documentTransport";

export async function loadTunnelStatus(): Promise<TunnelStatus> {
  const res = await hostFetch("/api/tunnel/status");
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<TunnelStatus>;
}
