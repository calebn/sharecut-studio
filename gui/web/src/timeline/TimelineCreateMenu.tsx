import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CreateMenu, type CreateMenuProps } from "../stages/edit/CreateMenu";
import { useDawStore } from "../state/dawStore";
import { useMenuKeyboard } from "../ui/useMenuKeyboard";
import { useTopLayerPanel } from "../ui/useTopLayerPanel";
import { formatTime } from "../utils/time";
import type { ChooserBounds } from "./chooserLayout";
import {
  createAnnouncement,
  createMenuRowsFor,
  type HostRowId,
  runCreatePick,
} from "./createMenuMapping";
import type { CreateView, HitRouter } from "./hitRouting";
import type { CreateMenuPlace } from "./touchGrammar";

export interface TimelineCreateMenuProps {
  view: CreateView;
  place: CreateMenuPlace;
  router: HitRouter;
  /** The timeline's visible box; the menu stays inside it. */
  bounds: ChooserBounds;
  /** The fixed playhead's x, which the popover sits beside; the phone Sheet ignores it. */
  avoidX: number | null;
  /** The phone shell: the rows show in a bottom Sheet instead of at the finger. */
  phone: boolean;
}

/**
 * A press outside the menu closes it with no change, and the click it would
 * have made is swallowed by the router's close. A right click outside closes
 * it without the native menu opening.
 */
function Scrim({ router, phone }: { router: HitRouter; phone: boolean }) {
  return (
    <div
      role="presentation"
      className="timeline-create-scrim"
      data-phone={phone ? "" : undefined}
      onPointerDown={(e) => {
        e.preventDefault();
        router.close();
      }}
      // The compat mousedown of the lift that opened the menu lands here, and
      // would pull focus off the menu, which closes when it loses focus.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

/**
 * Holds the keymap and owns Escape while the phone Sheet is up. The Sheet is a
 * non-modal overlay, so on its own it hands every shortcut on, and a menu is
 * what the keymap holds shut. There is no panel to arrow through (the rows are
 * plain buttons), so the hook's panel is empty; it still returns focus to
 * where the press began once the Sheet is gone.
 */
function useSheetKeyboard(close: () => void) {
  const panelRef = useRef<HTMLElement | null>(null);
  useMenuKeyboard({ open: true, panelRef, close });
}

/**
 * A touch open never focuses anything, so when the menu goes the focus has
 * nowhere to return to and falls to the page. Give it the press's own
 * focusable (a clip or a level), else the ruler's position slider.
 */
function focusAfterClose(surface: Element): void {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const target =
    surface.closest<HTMLElement>("[tabindex]") ??
    document.querySelector<HTMLElement>(
      '[role="slider"][aria-label="Timeline position"]',
    );
  target?.focus({ preventScroll: true });
}

/**
 * The host of the Create here menu in the timeline (#2294 S7b W1): the leaf
 * (`stages/edit/CreateMenu`) draws and positions the rows; this puts it in the
 * top layer over a scrim, announces it, picks the rows the session may run and
 * maps a picked row to its command at the held place. `hitRouting` owns the
 * gesture and reports the row under a sliding finger as `view.over`.
 */
export function TimelineCreateMenu({
  view,
  place,
  router,
  bounds,
  avoidX,
  phone,
}: TimelineCreateMenuProps) {
  // One set per held point: a second open elsewhere is a new place, and its
  // rows follow it, while a repaint of the same open keeps the rows it had.
  const rows = useMemo(() => createMenuRowsFor(place), [place]);
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
  const time = formatTime(place.atTime);
  const surfaceRef = useRef(view.surface);
  surfaceRef.current = view.surface;
  useEffect(
    () => () => {
      const surface = surfaceRef.current;
      // After the menu keyboard's own cleanup, which returns focus to where
      // the press began when that was a focusable; this only catches a fall.
      queueMicrotask(() => focusAfterClose(surface));
    },
    [],
  );
  const empty = rows.length === 0;
  useEffect(() => {
    if (empty) return;
    useDawStore
      .getState()
      .announceStatus(createAnnouncement(time, place.trackLabel, rows.length), {
        toast: false,
      });
  }, [empty, rows.length, place.trackLabel, time]);
  // A session that may run nothing here (a view-only link, off a lane, with
  // nothing copied) gets no menu: an empty one would be a title over nothing.
  useEffect(() => {
    if (empty) router.close();
  }, [empty, router]);
  const onPick = useCallback(
    (id: HostRowId) => {
      router.close();
      void runCreatePick(id, place);
    },
    [router, place],
  );
  const onClose = router.close;

  if (empty) return null;

  const menu = {
    rows,
    track: place.trackLabel,
    anchor: view.origin,
    bounds,
    onPick,
    onClose,
  };
  if (phone) {
    return (
      <PhoneMenu
        menu={{ ...menu, time: `Create at ${time}` }}
        router={router}
      />
    );
  }
  return createPortal(
    <div ref={attachLayer} popover={popover} className="timeline-create-layer">
      <Scrim router={router} phone={false} />
      {layer ? (
        <CreateMenu
          {...menu}
          time={time}
          viewport={{
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
          }}
          avoidX={avoidX}
          over={view.over}
          mark={place.lane}
        />
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * The phone form is the Sheet alone: it portals itself and has no top layer to
 * join. Its own scrim lets presses through (the sheet is non-modal), so a
 * transparent one of the host's sits under it and takes an outside tap.
 */
function PhoneMenu({
  menu,
  router,
}: {
  menu: Omit<CreateMenuProps, "phone">;
  router: HitRouter;
}) {
  useSheetKeyboard(menu.onClose);
  return (
    <>
      {createPortal(<Scrim router={router} phone />, document.body)}
      <CreateMenu {...menu} phone />
    </>
  );
}
