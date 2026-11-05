/** Server skips its pinned-project redirect for `/?home=1` (gui/server.py); tests/test_gui_api.py pins the two values. */
export const HOME_QUERY_PARAM = "home";

/** Home opens with Open other's path field showing (a browser with no OS folder picker). */
export const OPEN_OTHER_QUERY_PARAM = "openOther";

/** Home without unpinning or a redirect back to the pinned project. */
export function homeUrl(
  href: string,
  options: { openOther?: boolean } = {},
): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  url.searchParams.set(HOME_QUERY_PARAM, "1");
  if (options.openOther) url.searchParams.set(OPEN_OTHER_QUERY_PARAM, "1");
  else url.searchParams.delete(OPEN_OTHER_QUERY_PARAM);
  return url.toString();
}

/** Studio for `projectPath`, dropping a leftover `home` flag. */
export function projectUrl(href: string, projectPath: string): string {
  const url = new URL(href);
  url.searchParams.delete(HOME_QUERY_PARAM);
  url.searchParams.delete(OPEN_OTHER_QUERY_PARAM);
  url.searchParams.set("project", projectPath);
  return url.toString();
}

/** What a project file name ends in. */
const PROJECT_FILE_EXTENSION = ".sharecut";

/**
 * The episode's name as the path gives it: the folder that holds the project
 * file (`~/ShareCut/Rosa and Maya/episode.sharecut`), or the file's own name. A folder name with a dot in it is a name, not a file.
 * Used before the project has loaded; empty when the path gives none.
 */
export function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  const last = parts.pop() ?? "";
  if (!last.endsWith(PROJECT_FILE_EXTENSION)) return last;
  return parts.pop() ?? last.slice(0, -PROJECT_FILE_EXTENSION.length);
}
