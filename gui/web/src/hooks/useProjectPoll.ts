import { loadProjectMeta } from "../api";
import { loadDocumentState } from "../api/project";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import {
  currentDocumentSeq,
  pollSnapshotAlreadyApplied,
} from "../document/cursor";
import type { ProjectView } from "../types/project";
import { useFileMetaPoll } from "./useFileMetaPoll";

/** Sanity poll (every `SANITY_POLL_MS`, and on focus): reload ProjectView (shell) on an
episode.project.json mtime/size/seq change the document socket has not already delivered
— in practice a write that advanced no journal seq, since the server's cross-process
watcher pushes other processes' journal writes over the socket (#695). */
export function useProjectPoll(
  projectPath: string,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): void {
  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadProjectMeta(projectPath),
    async (meta) => {
      if (
        pollSnapshotAlreadyApplied(meta) ||
        ((meta.server_seq ?? 0) > 0 &&
          (meta.server_seq ?? 0) < currentDocumentSeq())
      )
        return;
      const scope = activateDocumentScope(projectPath);
      const snapshot = await loadDocumentState(projectPath);
      if (!isCurrentDocumentScope(scope) || pollSnapshotAlreadyApplied(meta))
        return;
      applyDocumentSnapshot(snapshot, { scope });
    },
  );
}
