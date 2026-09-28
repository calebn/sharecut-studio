const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * Wide-bar transport Menu tooltip: names exactly the sections the Menu shows.
 * Pass the same predicates that gate those `MenuSection`s in `TransportBar`
 * (Project and Markers: `mayManage`; Media: `mayIngest`; Help: always).
 */
export function transportMenuTitle({
  mayManage,
  mayIngest,
}: {
  mayManage: boolean;
  mayIngest: boolean;
}): string {
  const sections = [
    { label: "project", shown: mayManage },
    { label: "media", shown: mayIngest },
    { label: "markers", shown: mayManage },
    { label: "help", shown: true },
  ]
    .filter((s) => s.shown)
    .map((s) => s.label);
  const text = LIST.format(sections);
  return text.charAt(0).toUpperCase() + text.slice(1);
}
