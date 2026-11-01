import {
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
import {
  type InspectorSection,
  InspectorSheet,
} from "../../system/InspectorSheet";
import type {
  InspectorBounds,
  InspectorDetent,
  InspectorRect,
} from "../../system/inspectorSheetMath";
import { type AnchorRect, unionRect } from "../../ui/anchoredPlacement";
import { BottomSheet } from "../../ui/BottomSheet";
import { INSPECTOR_SHEET_CLASS } from "../../ui/compactSheet";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { EditActionBar } from "./EditActionBar";
import { useEnvelopePointSections } from "./envelopePointSections";
import { focusFirstControl } from "./inspectorFocus";
import { type InspectorHeading, inspectorHeading } from "./inspectorHeading";
import { rangeSection } from "./rangeSection";
import { useSelectionSections } from "./selectionSections";
import type { InspectorOpen, InspectorShell } from "./useInspectorOpen";
import { bandLocator, useKeepBandClear } from "./useKeepBandClear";
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
  useEffect(() => {
    if (!captured.current) {
      captured.current = true;
      const active = document.activeElement;
      opener.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
    }
    return () => {
      const was = opener.current;
      const now = document.activeElement;
      if (was?.isConnected && now === document.body)
        was.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!ready || entered.current) return;
    entered.current = true;
    if (document.activeElement?.closest(".ui-toast, .ui-toast-region--app"))
      return;
    if (box.current) focusFirstControl(box.current);
  }, [ready, box]);
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
                <SelectionSheetBody
                  rangeActionsInSheet={rangeActionsInSheet}
                  peek={null}
                />
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
  const anchor = useSelectionAnchor(root, selection, true);
  const box = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const measure = useCallback(() => {
    if (!root) return;
    const frame = root.getBoundingClientRect();
    const rects = [
      anchor.ref.current,
      // The card clears the Action bar that floats beside the same selection.
      root.querySelector(".sys-actions--floating"),
    ].flatMap((el) => (el ? [el.getBoundingClientRect()] : []));
    const target = rects.length
      ? rects.slice(1).reduce<AnchorRect>(unionRect, rects[0])
      : null;
    const next: Placement = {
      bounds: {
        width: Math.round(frame.width),
        height: Math.round(frame.height),
      },
      // Armed with nothing selected there is no object to sit beside: the bottom edge.
      anchor: rounded(
        target
          ? {
              x: target.left - frame.left,
              y: target.top - frame.top,
              width: target.right - target.left,
              height: target.bottom - target.top,
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
  const sections = useBodySections(sheet.rangeActionsInSheet, true);
  // The Action bar hides the same way when its anchor scrolls out.
  const shown = placement !== null && (anchor.visible || selection === null);
  useInspectorFocus(box, shown);
  return (
    <div ref={box} className="edit-inspector-slot" hidden={!shown}>
      {placement ? (
        <InspectorSheet
          form="card"
          {...heading}
          label="Inspector"
          sections={sections}
          anchor={placement.anchor}
          bounds={placement.bounds}
          onClose={sheet.close}
        />
      ) : null}
    </div>
  );
}

const DOCK_ROOM_PX = 420;
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
  const chosen = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const [lanes, setLanes] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const parent =
      box.current?.querySelector<HTMLElement>(".sys-inspector")?.offsetParent;
    setLanes(parent instanceof HTMLElement ? parent : null);
  }, []);
  const fit = useCallback(() => {
    const room = lanes?.clientHeight ?? 0;
    const short = room * SHEET_FULL < DOCK_ROOM_PX;
    setTight(short);
    if (short && room > 0 && !chosen.current) setDetent("full");
  }, [lanes]);
  useLayoutEffect(fit, [fit]);
  useResizeObserver(lanes, fit);
  const dockShown = !(detent === "full" && tight);
  const sections = useBodySections(sheet.rangeActionsInSheet, dockShown);
  useInspectorFocus(box, true);
  return (
    <div ref={box} className="edit-inspector-slot">
      <InspectorSheet
        form="phone"
        {...heading}
        label="Inspector"
        sections={sections}
        dock={
          dockShown ? (
            <EditActionBar form="dock" root={null} inInspector />
          ) : null
        }
        detent={detent}
        onDetentChange={(next) => {
          chosen.current = true;
          setDetent(next);
        }}
        onDismiss={sheet.dismiss}
        onClose={sheet.close}
      />
    </div>
  );
}

function PeekStrip({
  sheet,
  feedbackHostRef,
}: {
  sheet: InspectorOpen;
  feedbackHostRef?: RefCallback<HTMLDivElement>;
}) {
  const { sheetExpanded, setSheetExpanded } = useDaw((s) => ({
    sheetExpanded: s.sheetExpanded,
    setSheetExpanded: s.setSheetExpanded,
  }));
  const strip = sheet.strip;
  if (!strip) return null;
  return (
    <BottomSheet
      backgroundPolicy="interactive"
      open={sheet.open}
      onClose={sheet.close}
      title="Inspector"
      placement="sheet"
      className={INSPECTOR_SHEET_CLASS}
      expanded={sheetExpanded}
      onExpandedChange={setSheetExpanded}
      {...strip.props}
      bodyHeader={
        strip.props.stowed ? null : (
          <div ref={feedbackHostRef} className="compact-feedback-slot" />
        )
      }
    >
      <SelectionSheetBody
        rangeActionsInSheet={sheet.rangeActionsInSheet}
        peek={strip.peek}
      />
    </BottomSheet>
  );
}

/**
 * Mounts the Inspector sheet (design system 9a) for the Edit stage: a card
 * beside the selection on the desktop and the tablet, a bottom sheet with the
 * Action bar as its dock on the phone, where a timeline target still opens the
 * peek strip. Each kind's body is the legacy one, as one section of the frame,
 * until it is rebuilt from Scrub fields.
 */
export function InspectorHost({
  shell,
  sheet,
  root,
  regionRef,
  feedbackHostRef,
}: {
  shell: InspectorShell;
  sheet: InspectorOpen;
  root: HTMLElement | null;
  regionRef: RefCallback<HTMLDivElement>;
  feedbackHostRef?: RefCallback<HTMLDivElement>;
}) {
  const { selection, project } = useDaw((s) => ({
    selection: s.selection,
    project: s.project,
  }));
  const heading = inspectorHeading(selection, project);
  useKeepBandClear(
    shell === "phone" && sheet.open && !sheet.strip
      ? bandLocator(selection)
      : null,
  );
  if (sheet.strip) {
    return <PeekStrip sheet={sheet} feedbackHostRef={feedbackHostRef} />;
  }
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
