import { useCallback, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import type { StageId } from "../types/stage";

const MAX_RESTORE_FRAMES = 12;

/**
 * Keeps one scrolling pane's offset across a stage switch (the Script pane).
 * DOM only while the pane is up: the store hears the offset once, when the
 * pane unmounts, and `openStage` has already saved the stage's zoom by then.
 *
 * Returns a callback ref for a wrapper; `selector` names the scroller inside
 * it (the wrapper itself when omitted), because the scroller may mount after
 * the wrapper does.
 */
export function useStageScroll(
  stage: StageId,
  key: string,
  selector?: string,
): (node: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);

  return useCallback(
    (node: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!node) return;
      const scroller = () =>
        selector ? node.querySelector<HTMLElement>(selector) : node;
      const saved =
        useDawStore.getState().stageViews[stage]?.panelScroll[key] ?? 0;
      let top = saved;
      let frame = 0;
      let tries = 0;
      const restore = () => {
        const el = scroller();
        if (el) {
          el.scrollTop = saved;
          if (el.scrollTop === saved) return;
        }
        // The list can mount or measure after its wrapper: try again next frame.
        if (++tries < MAX_RESTORE_FRAMES)
          frame = requestAnimationFrame(restore);
      };
      if (saved > 0) restore();
      const onScroll = (e: Event) => {
        if (e.target === scroller()) top = (e.target as HTMLElement).scrollTop;
      };
      node.addEventListener("scroll", onScroll, true);
      cleanup.current = () => {
        cancelAnimationFrame(frame);
        node.removeEventListener("scroll", onScroll, true);
        if (top !== saved) {
          useDawStore.getState().setPanelScroll(stage, key, top);
        }
      };
    },
    [stage, key, selector],
  );
}
