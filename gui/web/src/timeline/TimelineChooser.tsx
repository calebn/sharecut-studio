import {
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { TARGET_ID_ATTR } from "../stages/edit/chooserKinds";
import { CHOOSER_MAX_CHIPS } from "../stages/edit/chooserMath";
import type { Bounds } from "../stages/edit/createMenuLayout";
import { TargetChooser } from "../stages/edit/TargetChooser";
import { useDawStore } from "../state/dawStore";
import { useTopLayerPanel } from "../ui/useTopLayerPanel";
import { chooserTargetsOf } from "./chooserTargets";
import type { ChooserView, HitRouter } from "./hitRouting";
import { Scrim } from "./TimelineCreateMenu";

export interface TimelineChooserProps {
  view: ChooserView;
  router: HitRouter;
  /** The timeline's visible box; the fan stays inside it. */
  bounds: Bounds;
}

function announcement(total: number): string {
  return total > CHOOSER_MAX_CHIPS
    ? `${total} targets here, showing ${CHOOSER_MAX_CHIPS} of ${total}`
    : `${total} targets here`;
}

function chipId(target: EventTarget | null): string | null {
  return target instanceof Element
    ? (target.closest(`[${TARGET_ID_ATTR}]`)?.getAttribute(TARGET_ID_ATTR) ??
        null)
    : null;
}

/**
 * The host of the touch target chooser in the timeline (#2294 S7b W4): the
 * leaf (`stages/edit/TargetChooser`) draws and positions the chips; this puts
 * it in the top layer over a scrim, announces it, maps the router's hits to
 * its targets and a picked chip back to `router.choose`. `hitRouting` owns the
 * gesture and reports the chip under a sliding finger as `view.over`.
 */
export function TimelineChooser({
  view,
  router,
  bounds,
}: TimelineChooserProps) {
  const { ref: topLayerRef, popover } = useTopLayerPanel();
  // The leaf measures itself as it mounts, and a popover that is not showing
  // has no size, so it mounts once the layer is in the top layer.
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const attachLayer = useCallback(
    (el: HTMLDivElement | null) => {
      setLayer(el);
      return topLayerRef(el);
    },
    [topLayerRef],
  );
  const targets = useMemo(() => chooserTargetsOf(view.hits), [view.hits]);
  const total = targets.length;
  useEffect(() => {
    useDawStore
      .getState()
      .announceStatus(announcement(total), { toast: false });
  }, [total]);

  const [focused, setFocused] = useState<string | null>(null);
  const pointerType = useRef("");
  const pickType = useRef("virtual");
  const onPointerDownCapture = (e: PointerEvent<HTMLDivElement>) => {
    pointerType.current = e.pointerType;
    // No compatibility mousedown: it would land on the timeline once the
    // chooser unmounts and pull focus off the picked target.
    if (chipId(e.target) !== null) e.preventDefault();
  };
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    pickType.current =
      e.detail === 0 || pointerType.current === ""
        ? "virtual"
        : pointerType.current;
    pointerType.current = "";
  };
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    setFocused(chipId(e.target));
  };
  const onPick = useCallback(
    (id: string) => router.choose(Number(id), pickType.current),
    [router],
  );

  return createPortal(
    <div ref={attachLayer} popover={popover} className="timeline-chooser-layer">
      <Scrim router={router} phone={false} />
      <div
        className="timeline-chooser-host"
        onPointerDownCapture={onPointerDownCapture}
        onClickCapture={onClickCapture}
        onFocus={onFocus}
      >
        {layer ? (
          <TargetChooser
            targets={targets}
            anchor={view.origin}
            bounds={bounds}
            over={view.over === null ? focused : String(view.over)}
            onPick={onPick}
            onCancel={router.close}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
