import {
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SelectionSheetBody } from "../../inspector/SelectionSheetBody";
import { useDaw } from "../../state/useDaw";
import type { BarId } from "../../system/editActionSets";
import {
  type InspectorHistory,
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import {
  cardFits,
  type InspectorBounds,
  type InspectorDetent,
  type InspectorRect,
  scaledMinBlock,
} from "../../system/inspectorSheetMath";
import { openerControl } from "../../ui/pressedControl";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { useHistoryControls } from "../frame/useHistoryControls";
import { CommentPopover } from "./CommentPopover";
import { commentTarget } from "./commentSections";
import { compactTarget } from "./compactTarget";
import { EditActionBar } from "./EditActionBar";
import { useEnvelopePointSections } from "./envelopePointSections";
import { focusFirstControl } from "./inspectorFocus";
import { type InspectorHeading, inspectorHeading } from "./inspectorHeading";
import { rangeSection } from "./rangeSection";
import { useSelectionSections } from "./selectionSections";
import type { InspectorOpen, InspectorShell } from "./useInspectorOpen";
import { bandLocator, useKeepTargetClear } from "./useKeepTargetClear";
import { useRevealEditedLane } from "./useRevealEditedLane";
import { useSelectionAnchor } from "./useSelectionAnchor";

/**
 * Focus belongs to the host (design system 9a): on open it remembers where it
 * was and moves into the first control (the dialog when that control takes text); when the Inspector goes (Esc, Close, a
 * new selection, the phone sheet dismissed) it returns to that opener unless
 * the user has already put it somewhere else.
 */
function useInspectorFocus(box: RefObject<HTMLElement | null>, ready: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const entered = useRef(false);
  const captured = useRef(false);
  const preserveOutsideFocus = useRef(false);
  const dismissal = useRef<{
    pointerId: number;
    control: HTMLButtonElement;
    owner: HTMLElement;
    fallback: HTMLElement | null;
    clicked: boolean;
  } | null>(null);
  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      dismissal.current = null;
      const control = (event.target as Element).closest<HTMLButtonElement>(
        "button.dialog-close",
      );
      const owner = document.activeElement;
      if (
        event.button !== 0 ||
        !control ||
        !control.closest(".sys-inspector-header") ||
        !box.current?.contains(control) ||
        !(owner instanceof HTMLElement) ||
        !box.current.contains(owner)
      )
        return;
      dismissal.current = {
        pointerId: event.pointerId,
        control,
        owner,
        fallback: null,
        clicked: false,
      };
    },
    [box],
  );
  const onBlurCapture = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      const receipt = dismissal.current;
      const next = event.relatedTarget;
      if (
        !receipt ||
        !(next instanceof HTMLElement) ||
        !next.isConnected ||
        event.target !== receipt.owner ||
        !next.contains(box.current)
      )
        return;
      receipt.fallback = next;
    },
    [box],
  );
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    const receipt = dismissal.current;
    const target = (event.target as Element).closest<HTMLButtonElement>(
      "button.dialog-close",
    );
    if (
      !receipt ||
      event.detail === 0 ||
      target !== receipt.control ||
      !receipt.fallback ||
      ("pointerId" in event.nativeEvent &&
        event.nativeEvent.pointerId !== receipt.pointerId)
    ) {
      dismissal.current = null;
      return;
    }
    receipt.clicked = true;
  }, []);
  const onPointerCancelCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (dismissal.current?.pointerId === event.pointerId)
        dismissal.current = null;
    },
    [],
  );
  const onKeyDownCapture = useCallback(() => {
    dismissal.current = null;
  }, []);
  const close = useCallback(() => {
    const receipt = dismissal.current;
    dismissal.current = null;
    const now = document.activeElement;
    const ownsFocus = box.current?.contains(now) ?? false;
    const matchedPointerDismissal =
      receipt?.clicked === true && receipt.fallback === now;
    const was = opener.current;
    if ((ownsFocus || matchedPointerDismissal) && was?.isConnected)
      was.focus({ preventScroll: true });
    else if (
      now instanceof HTMLElement &&
      now !== document.body &&
      !box.current?.contains(now)
    )
      preserveOutsideFocus.current = true;
  }, [box]);
  useEffect(() => {
    if (!captured.current) {
      captured.current = true;
      opener.current = openerControl();
    }
    return () => {
      const was = opener.current;
      const now = document.activeElement;
      if (
        !preserveOutsideFocus.current &&
        was?.isConnected &&
        (now === document.body ||
          (now instanceof HTMLElement && now.contains(was)))
      )
        was.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!ready || entered.current) return;
    const active = document.activeElement;
    const was = opener.current;
    if (
      was
        ? active !== was &&
          active !== document.body &&
          !(active instanceof HTMLElement && active.contains(was))
        : active !== document.body
    )
      return;
    entered.current = true;
    if (active?.closest(".ui-toast, .ui-toast-region--app")) return;
    if (box.current) focusFirstControl(box.current);
  }, [ready, box]);
  return {
    close,
    onBlurCapture,
    onClickCapture,
    onKeyDownCapture,
    onPointerCancelCapture,
    onPointerDownCapture,
  };
}

function useBodySections(
  rangeActionsInSheet: boolean,
  barShown = false,
): readonly InspectorSection[] {
  const envelope = useEnvelopePointSections(useDaw((s) => s.selection));
  const rebuilt = useSelectionSections(
    useDaw((s) => s.selection),
    rangeActionsInSheet,
    barShown,
  );
  const legacy = useMemo(
    () => [
      {
        id: "body",
        rows: [
          {
            id: "body",
            control: (
              <div className="edit-inspector-body">
                <SelectionSheetBody rangeActionsInSheet={rangeActionsInSheet} />
              </div>
            ),
          },
        ],
      },
    ],
    [rangeActionsInSheet],
  );
  if (rebuilt) return rebuilt;
  if (!envelope) return legacy;
  return rangeActionsInSheet ? [...envelope, rangeSection] : envelope;
}

const rounded = (rect: InspectorRect): InspectorRect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

type Placement = { anchor: InspectorRect; bounds: InspectorBounds };

const samePlacement = (a: Placement | null, b: Placement) =>
  a != null &&
  a.bounds.width === b.bounds.width &&
  a.bounds.height === b.bounds.height &&
  a.anchor.x === b.anchor.x &&
  a.anchor.y === b.anchor.y &&
  a.anchor.width === b.anchor.width &&
  a.anchor.height === b.anchor.height;

function Card({
  sheet,
  heading,
  root,
}: {
  sheet: InspectorOpen;
  heading: InspectorHeading;
  root: HTMLElement | null;
}) {
  const selection = useDaw((s) => s.selection);
  const threadId = useDaw((s) =>
    s.selection?.kind === "comment" &&
    commentTarget(s.selection, s.project) === "thread"
      ? s.selection.id
      : null,
  );
  const popoverId = sheet.rangeActionsInSheet ? null : threadId;
  const anchor = useSelectionAnchor(root, selection, true);
  const [anchorTrackId, setAnchorTrackId] = useState<string | null>(null);
  useLayoutEffect(() => {
    setAnchorTrackId(
      selection?.kind === "clip"
        ? (anchor.ref.current?.closest<HTMLElement>(".lane-row")?.dataset
            .trackId ?? null)
        : null,
    );
  }, [selection, anchor.ref, anchor.moves]);
  useRevealEditedLane(anchorTrackId);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const measure = useCallback(() => {
    if (!root) return;
    const frame = root.getBoundingClientRect();
    const target =
      root.querySelector<HTMLElement>(".sys-actions--floating") ??
      anchor.ref.current;
    const targetRect = target?.getBoundingClientRect();
    const next: Placement = {
      bounds: {
        width: Math.round(frame.width),
        height: Math.round(frame.height),
      },
      // Armed with nothing selected there is no object to sit beside: the bottom edge.
      anchor: rounded(
        targetRect
          ? {
              x: targetRect.left - frame.left,
              y: targetRect.top - frame.top,
              width: targetRect.right - targetRect.left,
              height: targetRect.bottom - targetRect.top,
            }
          : { x: frame.width / 2, y: frame.height, width: 0, height: 0 },
      ),
    };
    setPlacement((was) => (samePlacement(was, next) ? was : next));
  }, [root, anchor.ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a zoom, a new anchor node or a new selection moves the anchor
  useLayoutEffect(() => {
    measure();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && box.current?.contains(event.target))
        return;
      measure();
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [measure, anchor.moves, anchor.visible]);
  useResizeObserver(root, measure);
  const history = useTakeoverHistory();
  const takeover =
    placement !== null &&
    !cardFits(placement.bounds.height, scaledMinBlock(rootFontPx()));
  // The takeover has no Action bar beside it, so the sheet keeps the verbs.
  const sections = useBodySections(sheet.rangeActionsInSheet, !takeover);
  // The Action bar hides the same way when its anchor scrolls out.
  const shown = placement !== null && (anchor.visible || selection === null);
  const focus = useInspectorFocus(popoverId ? panel : box, shown);
  const hadPopover = useRef(false);
  useEffect(() => {
    if (
      hadPopover.current &&
      !popoverId &&
      document.activeElement === document.body &&
      box.current
    )
      focusFirstControl(box.current);
    hadPopover.current = popoverId !== null;
  }, [popoverId]);
  const close = () => {
    focus.close();
    sheet.close();
  };
  let card: ReactNode = null;
  if (popoverId) {
    if (placement)
      card = (
        <CommentPopover
          commentId={popoverId}
          anchor={anchor}
          root={root}
          panelRef={panel}
          away={!shown}
          onClose={close}
        />
      );
  } else if (placement) {
    card = !takeover ? (
      <InspectorSheet
        form="card"
        {...heading}
        label="Inspector"
        sections={sections}
        anchor={placement.anchor}
        bounds={placement.bounds}
        onClose={close}
      />
    ) : (
      <InspectorSheet
        form="takeover"
        {...heading}
        history={history}
        label="Inspector"
        sections={sections}
        onClose={close}
      />
    );
  }
  return (
    <div
      ref={box}
      className="edit-inspector-slot"
      hidden={!shown}
      onBlurCapture={focus.onBlurCapture}
      onClickCapture={focus.onClickCapture}
      onKeyDownCapture={focus.onKeyDownCapture}
      onPointerCancelCapture={focus.onPointerCancelCapture}
      onPointerDownCapture={focus.onPointerDownCapture}
    >
      {card}
    </div>
  );
}

const DEFAULT_ROOT_FONT_PX = 16;

function rootFontPx() {
  return (
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    DEFAULT_ROOT_FONT_PX
  );
}

const FIELD_VERBS: ReadonlySet<BarId> = new Set([
  "fixText",
  "adjustBounds",
  "fade",
  "moveToTrack",
]);
/** The room half needs to hold the dock and a few fields, in rem so large text asks for more. */
const DOCK_ROOM_REM = 26.25;
const SHEET_FULL = 0.92;

function Phone({
  sheet,
  heading,
}: {
  sheet: InspectorOpen;
  heading: InspectorHeading;
}) {
  const [detent, setDetent] = useState<InspectorDetent>("half");
  const [tight, setTight] = useState(false);
  const history = useTakeoverHistory();
  const [takeover, setTakeover] = useState(false);
  const chosen = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Read once, from the phone sheet's first mount, so the slot can still be
  // measured after the takeover has replaced that sheet.
  const [lanes, setLanes] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const parent =
      box.current?.querySelector<HTMLElement>(".sys-inspector")?.offsetParent;
    setLanes(parent instanceof HTMLElement ? parent : null);
  }, []);
  const fit = useCallback(() => {
    const room = lanes?.clientHeight ?? 0;
    const rootPx = rootFontPx();
    const short = room * SHEET_FULL < DOCK_ROOM_REM * rootPx;
    setTight(short);
    setTakeover(room > 0 && room * SHEET_FULL < scaledMinBlock(rootPx));
    if (room > 0 && !chosen.current) setDetent(short ? "full" : "half");
  }, [lanes]);
  useLayoutEffect(fit, [fit]);
  useResizeObserver(lanes, fit);
  const dockShown = !(detent === "full" && tight);
  // A verb that opens the Inspector's fields (Fix text on a chapter, Adjust
  // bounds) raises a sheet resting on its dock, and the field takes focus.
  const [focusFields, setFocusFields] = useState(false);
  const raiseForFields = useCallback((id: BarId) => {
    if (!FIELD_VERBS.has(id)) return;
    chosen.current = true;
    setDetent((now) => (now === "dock" ? "half" : now));
    setFocusFields(true);
  }, []);
  useEffect(() => {
    if (!focusFields) return;
    setFocusFields(false);
    if (box.current) focusFirstControl(box.current);
  }, [focusFields]);
  const sections = useBodySections(
    sheet.rangeActionsInSheet,
    dockShown && !takeover,
  );
  const focus = useInspectorFocus(box, true);
  return (
    <div
      ref={box}
      className="edit-inspector-slot"
      onBlurCapture={focus.onBlurCapture}
      onClickCapture={focus.onClickCapture}
      onKeyDownCapture={focus.onKeyDownCapture}
      onPointerCancelCapture={focus.onPointerCancelCapture}
      onPointerDownCapture={focus.onPointerDownCapture}
    >
      {takeover ? (
        <InspectorSheet
          form="takeover"
          {...heading}
          history={history}
          label="Inspector"
          sections={sections}
          onClose={() => {
            focus.close();
            sheet.close();
          }}
        />
      ) : (
        <InspectorSheet
          form="phone"
          {...heading}
          label="Inspector"
          sections={sections}
          dock={
            dockShown ? (
              <EditActionBar
                form="dock"
                root={null}
                inInspector
                onRan={raiseForFields}
              />
            ) : null
          }
          detent={detent}
          onDetentChange={(next) => {
            chosen.current = true;
            setDetent(next);
          }}
          onDismiss={sheet.dismiss}
          onClose={() => {
            focus.close();
            sheet.close();
          }}
        />
      )}
    </div>
  );
}

/**
 * Mounts the Inspector sheet (design system 9a) for the Edit stage: a card
 * beside the selection on the desktop and the tablet, a bottom sheet with the
 * Action bar as its dock on the phone (dock, half and full detents). Each kind's body is the legacy one, as one section of the frame,
 * until it is rebuilt from Scrub fields.
 */
export function InspectorHost({
  shell,
  sheet,
  root,
  regionRef,
}: {
  shell: InspectorShell;
  sheet: InspectorOpen;
  root: HTMLElement | null;
  regionRef: RefCallback<HTMLDivElement>;
}) {
  const { selection, project, hit, rangeArmed, dragging } = useDaw((s) => ({
    selection: s.selection,
    project: s.project,
    hit: s.selectionHit,
    rangeArmed: s.rangeArmed,
    dragging: s.timelineDragging,
  }));
  const heading = inspectorHeading(selection, project);
  const target =
    !rangeArmed && project ? compactTarget(project, selection, hit) : null;
  useKeepTargetClear(
    shell === "phone" && sheet.open
      ? (target?.locate ?? bandLocator(selection))
      : null,
    dragging,
  );
  if (!sheet.open) return null;
  return (
    <div ref={regionRef} className="edit-inspector-region">
      {shell === "phone" ? (
        <Phone sheet={sheet} heading={heading} />
      ) : (
        <Card sheet={sheet} heading={heading} root={root} />
      )}
    </div>
  );
}

/** Undo and Redo for the full-screen Inspector, which covers the app header. */
function useTakeoverHistory(): InspectorHistory | undefined {
  const { history, onUndo, onRedo } = useHistoryControls();
  return history ? { ...history, onUndo, onRedo } : undefined;
}
