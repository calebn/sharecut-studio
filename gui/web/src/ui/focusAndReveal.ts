/**
 * How far sticky children pinned at the top of `scroller` (a sheet's chrome)
 * cover its viewport: a control revealed under them would still be hidden.
 */
function stickyInset(scroller: HTMLElement): number {
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  let inset = 0;
  for (const child of scroller.children) {
    if (getComputedStyle(child).position !== "sticky") continue;
    const rect = child.getBoundingClientRect();
    if (rect.top <= top + 1) inset = Math.max(inset, rect.bottom - top);
  }
  return inset;
}

/** Focus and minimally reveal a control inside its inspector, never the page
 * or timeline. Callers retain ownership of selection and lifecycle timing. */
export function focusAndReveal(target: HTMLElement | null): void {
  if (!target?.isConnected || target.matches(":disabled")) return;
  target.focus({ preventScroll: true });
  if (document.activeElement !== target) return;
  const boundary =
    target.closest<HTMLElement>(".bottom-sheet") ??
    target.closest<HTMLElement>(".inspector");
  if (!boundary) return;
  const label = target.closest<HTMLElement>("label");
  const descriptions = (target.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter(
      (element): element is HTMLElement =>
        element !== null && boundary.contains(element),
    );
  const style = getComputedStyle(target);
  const ring =
    (Number.parseFloat(style.outlineWidth) || 0) +
    (Number.parseFloat(style.outlineOffset) || 0);
  for (
    let parent = target.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const overflow = getComputedStyle(parent);
    const viewport = parent.getBoundingClientRect();
    const top = viewport.top + parent.clientTop + stickyInset(parent);
    const left = viewport.left + parent.clientLeft;
    const labelRect = label?.getBoundingClientRect();
    let rect: Pick<DOMRect, "top" | "bottom" | "left" | "right"> =
      labelRect &&
      labelRect.height + ring * 2 <= parent.clientHeight &&
      labelRect.width + ring * 2 <= parent.clientWidth
        ? labelRect
        : target.getBoundingClientRect();
    for (const description of descriptions) {
      const described = description.getBoundingClientRect();
      const group = {
        top: Math.min(rect.top, described.top),
        bottom: Math.max(rect.bottom, described.bottom),
        left: Math.min(rect.left, described.left),
        right: Math.max(rect.right, described.right),
      };
      if (
        group.bottom - group.top + ring * 2 <= parent.clientHeight &&
        group.right - group.left + ring * 2 <= parent.clientWidth
      )
        rect = group;
    }
    if (
      /(auto|scroll)/.test(overflow.overflowY) &&
      parent.scrollHeight > parent.clientHeight
    ) {
      const bottom = top + parent.clientHeight;
      parent.scrollTop +=
        rect.top - ring < top
          ? rect.top - ring - top
          : rect.bottom + ring > bottom
            ? rect.bottom + ring - bottom
            : 0;
    }
    if (
      /(auto|scroll)/.test(overflow.overflowX) &&
      parent.scrollWidth > parent.clientWidth
    ) {
      const right = left + parent.clientWidth;
      parent.scrollLeft +=
        rect.left - ring < left
          ? rect.left - ring - left
          : rect.right + ring > right
            ? rect.right + ring - right
            : 0;
    }
    if (parent === boundary) break;
  }
}
