import { isShareProjectKey } from "../shareMode";
import type { ProsodyOverlay } from "../types/prosody";
import { hostFetch } from "./documentTransport";

/** Host-only: the cached prosody overlay (#719); null for a share key, no project, or a failed request. */
export async function loadProsodyOverlay(
  projectPath: string,
  signal?: AbortSignal,
): Promise<ProsodyOverlay | null> {
  if (!projectPath || isShareProjectKey(projectPath)) return null;
  const params = new URLSearchParams({ path: projectPath });
  const res = await hostFetch(`/api/project/prosody?${params.toString()}`, {
    signal,
  });
  if (!res.ok) return null;
  return (await res.json()) as ProsodyOverlay;
}
