import { type RefObject, useLayoutEffect } from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

export function usePhoneEnvelopeSheet(
  workspace: RefObject<HTMLDivElement | null>,
  trackId: string | undefined,
  root: HTMLElement | null,
) {
  const lane = () =>
    trackId
      ? document.querySelector<HTMLElement>(
          `.lane-row[data-track-id="${CSS.escape(trackId)}"]`,
        )
      : null;
  const panel = () => workspace.current?.closest<HTMLElement>(".bottom-sheet");
  const scroller = () => lane()?.closest<HTMLElement>(".timeline-scroll");
  const measure = () => {
    const sheet = panel();
    const target = lane();
    const scroll = scroller();
    if (!root || !sheet || !target || !scroll) return;
    const slot = root.getBoundingClientRect();
    const chrome =
      scroll.querySelector(".marker-lane")?.getBoundingClientRect().bottom ??
      scroll.getBoundingClientRect().top;
    const targetHeight = target.getBoundingClientRect().height;
    let cap = Math.max(
      0,
      slot.bottom - Math.max(slot.top, chrome) - targetHeight,
    );
    const header =
      sheet.querySelector(".bottom-sheet-chrome")?.getBoundingClientRect()
        .height ?? 0;
    const form =
      workspace.current
        ?.querySelector("form, .envelope-workspace-actions")
        ?.getBoundingClientRect().height ?? 0;
    if (
      document.documentElement.dataset.keyboard === "open" &&
      cap < header + form
    )
      cap = slot.height;
    sheet.style.setProperty("--phone-envelope-cap", `${Math.floor(cap)}px`);
    sheet.dataset.phoneEnvelope = "true";
    scroll.style.setProperty(
      "--sheet-clearance",
      `${Math.ceil(sheet.offsetHeight)}px`,
    );
    const bottom = slot.bottom - sheet.offsetHeight;
    const rect = target.getBoundingClientRect();
    const delta = Math.min(rect.bottom - bottom, rect.top - chrome);
    if (delta > 0) scroll.scrollTop += delta;
  };
  useLayoutEffect(measure);
  useResizeObserver([root, panel, scroller], measure, root !== null);
  useLayoutEffect(() => {
    const sheet = workspace.current?.closest<HTMLElement>(".bottom-sheet");
    const target =
      root && trackId
        ? document.querySelector<HTMLElement>(
            `.lane-row[data-track-id="${CSS.escape(trackId)}"]`,
          )
        : null;
    const scroll = target?.closest<HTMLElement>(".timeline-scroll");
    return () => {
      sheet?.style.removeProperty("--phone-envelope-cap");
      if (sheet) delete sheet.dataset.phoneEnvelope;
      scroll?.style.removeProperty("--sheet-clearance");
    };
  }, [root, trackId, workspace]);
}
