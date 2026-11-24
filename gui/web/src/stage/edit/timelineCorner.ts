export function timelineCorner(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  const corner = root?.querySelector<HTMLElement>(
    ":scope > .edit-timeline-col > .edit-corner",
  );
  if (!corner) return null;
  const { width, height } = corner.getBoundingClientRect();
  return width > 0 && height > 0 ? corner : null;
}
