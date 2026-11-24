export function timelineCorner(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>(
      ":scope > .edit-timeline-col > .edit-corner",
    ) ?? null
  );
}
