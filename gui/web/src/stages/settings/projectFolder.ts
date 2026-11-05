import { EPISODE_PROJECT_FILENAME } from "../../utils/projectFile";

/** The folder an episode is saved in, from the path the app holds for it. */
export function projectFolderOf(projectPath: string): string {
  const entry = `/${EPISODE_PROJECT_FILENAME}`;
  return projectPath.endsWith(entry)
    ? projectPath.slice(0, -entry.length)
    : projectPath;
}
