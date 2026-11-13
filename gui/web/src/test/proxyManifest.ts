import { type ProxyManifest, projectProxyBasis } from "../audio/proxyMath";
import type { ProjectView } from "../types/project";

/** A one-chunk proxy manifest for a project with a single "host" track. */
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
