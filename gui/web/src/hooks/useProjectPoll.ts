import { loadProject, loadProjectMeta } from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  currentDocumentSeq,
  notePolledDocumentFile,
  pollSnapshotAlreadyApplied,
  shouldApplyPollSnapshot,
} from "../document/cursor";
import type { ProjectView } from "../types/project";
import { useFileMetaPoll } from "./useFileMetaPoll";

const POLL_MS = 1500;

/** Reload ProjectView (shell) on an episode.project.json mtime/size change the document
socket has not already delivered (a write from another process, or while the socket is
down). */
export function useProjectPoll(
  projectPath: string,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): void {
  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadProjectMeta(projectPath),
    async (meta) => {
      // The socket already applied this exact file (#657): no second GET / force-apply.
      if (pollSnapshotAlreadyApplied(meta)) {
        return;
      }
      const metaSeq = meta.server_seq ?? 0;
      if (!shouldApplyPollSnapshot(metaSeq, currentDocumentSeq())) {
        return;
      }
      const project = await loadProject(projectPath);
      // The socket (or this client's own command result) may have delivered this
      // exact file while the GET was in flight (#657).
      if (
        pollSnapshotAlreadyApplied(meta) ||
        !shouldApplyPollSnapshot(metaSeq, currentDocumentSeq())
      ) {
        return;
      }
      applyDocumentSnapshot({ project, server_seq: metaSeq }, { force: true });
      notePolledDocumentFile(meta);
    },
    POLL_MS,
  );
}
