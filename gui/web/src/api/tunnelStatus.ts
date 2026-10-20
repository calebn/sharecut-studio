import type { TunnelStatus } from "../types/tunnel";
import { apiFetch, HOST_KEY } from "./http";

export async function loadTunnelStatus(): Promise<TunnelStatus> {
  const res = await apiFetch(HOST_KEY, { host: "/api/tunnel/status" });
  return res.json() as Promise<TunnelStatus>;
}
