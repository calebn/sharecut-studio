/** Server skips its pinned-project redirect for `/?home=1` (gui/server.py). */
export const HOME_QUERY_PARAM = "home";

/** Home without unpinning or a redirect back to the pinned project. */
export function homeUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("project");
  url.searchParams.set(HOME_QUERY_PARAM, "1");
  return url.toString();
}

/** Studio for `projectPath`, dropping a leftover `home` flag. */
export function projectUrl(href: string, projectPath: string): string {
  const url = new URL(href);
  url.searchParams.delete(HOME_QUERY_PARAM);
  url.searchParams.set("project", projectPath);
  return url.toString();
}
