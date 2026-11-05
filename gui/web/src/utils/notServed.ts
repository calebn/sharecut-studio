/**
 * The server answers a browser that asks for a project it does not serve with
 * the app shell (HTTP 403) and the facts for the cover in a JSON element, so
 * the page is the same Status cover as every other "nothing to show here".
 * Must match `NOT_SERVED_ELEMENT_ID` in gui/server.py.
 */
export const NOT_SERVED_ELEMENT_ID = "sharecut-not-served";

export type NotServed = {
  name: string;
  openHref: string;
  /** The host home (`/?home=1`, keeps the session token). */
  homeHref: string;
};

export function readNotServed(doc: Document = document): NotServed | null {
  const raw = doc.getElementById(NOT_SERVED_ELEMENT_ID)?.textContent;
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const { name, open_href, home_href } = data as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      typeof open_href !== "string" ||
      typeof home_href !== "string"
    ) {
      return null;
    }
    return { name, openHref: open_href, homeHref: home_href };
  } catch {
    return null;
  }
}
