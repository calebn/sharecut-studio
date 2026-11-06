import { isShareProjectKey } from "../../shareMode";
import { EPISODE_PROJECT_FILENAME } from "../../utils/projectFile";

/**
 * The folder an episode is saved in, from the path the app holds for it.
 * A share link has no folder on this computer, so it has none to show.
 */
export function projectFolderOf(projectPath: string): string | undefined {
  if (isShareProjectKey(projectPath)) return undefined;
  const entry = `/${EPISODE_PROJECT_FILENAME}`;
  return projectPath.endsWith(entry)
    ? projectPath.slice(0, -entry.length)
    : projectPath;
}
