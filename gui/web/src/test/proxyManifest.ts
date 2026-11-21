import { type ProxyManifest, projectProxyBasis } from "../audio/proxyMath";
import type { ProjectView } from "../types/project";

/**
 * Hand-built one-chunk response for client hook tests. It exercises transport
 * behavior for the supplied project basis, not server manifest generation.
 */
export function hostProxyManifest(project: ProjectView): ProxyManifest {
  return {
    revision: "revision",
    project_basis: projectProxyBasis(project),
    tracks: {
      host: {
        hash: "a".repeat(16),
        chunk_sec: 60,
        overlap_ms: 200,
        chunk_count: 1,
        duration_sec: 60,
        urls: ["u0"],
      },
    },
    artifacts: {},
    occurrences: {},
  };
}
