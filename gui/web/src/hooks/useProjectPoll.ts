import { loadProject, loadProjectMeta } from "../api";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import {
  currentDocumentSeq,
  shouldApplyPollSnapshot,
} from "../document/cursor";
import type { ProjectView } from "../types/project";
import { useFileMetaPoll } from "./useFileMetaPoll";

const POLL_MS = 1500;

/** Reload ProjectView (shell) when episode.project.json mtime/size changes. */
export function useProjectPoll(
  projectPath: string,
  _setProject: (project: ProjectView) => void,
  enabled = true,
): void {
  useFileMetaPoll(
    enabled && Boolean(projectPath),
    () => loadProjectMeta(projectPath),
    async (meta) => {
      const metaSeq = meta.server_seq ?? 0;
      const project = await loadProject(projectPath);
      if (!shouldApplyPollSnapshot(metaSeq, currentDocumentSeq())) {
        return;
      }
      applyDocumentSnapshot({ project, server_seq: metaSeq }, { force: true });
    },
    POLL_MS,
  );
}
