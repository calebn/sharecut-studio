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
