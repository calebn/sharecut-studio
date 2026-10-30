import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { CloseButton } from "../ui";
import type { SystemIconName } from "./icons";
import {
  CARD_WIDTH_PX,
  DOCK_PX,
  dragHeight,
  INSPECTOR_DETENTS,
  type InspectorBounds,
  type InspectorDetent,
  type InspectorRect,
  placeCard,
  riseVelocity,
  type Sample,
  settleDetent,
  steppedDetent,
  toggledDetent,
} from "./inspectorSheetMath";
import { SystemIcon } from "./SystemIcon";
import { useGrab } from "./useGrab";

type InspectorRow = {
  id: string;
  /** A row without a label gives the control the whole width. */
  label?: string;
  control: ReactNode;
};

export type InspectorSection = {
  id: string;
  /** A titled section collapses by its heading; one without a title is always open. */
  title?: string;
  rows: readonly InspectorRow[];
  defaultCollapsed?: boolean;
};

type InspectorBase = {
  icon: SystemIconName;
  name: string;
  /** The dialog's accessible name when the host keeps a fixed one; the name is then the visible title. */
  label?: string;
  /** Makes the name an inline field; the new name is reported on Enter or blur. */
  onRename?: (name: string) => void;
  sections: readonly InspectorSection[];
  onClose: () => void;
};

export type InspectorCardProps = InspectorBase & {
  form: "card";
  /** In the coordinates of `bounds`, the box the card is placed in. */
  anchor: InspectorRect;
  bounds: InspectorBounds;
};

export type InspectorPhoneProps = InspectorBase & {
  form: "phone";
  /** The first detent. */
  dock?: ReactNode;
  detent: InspectorDetent;
  onDetentChange: (detent: InspectorDetent) => void;
  /** Dragged down past the dock: the host clears the selection. */
  onDismiss: () => void;
};

type InspectorSheetProps = InspectorCardProps | InspectorPhoneProps;

const DETENT_TEXT: Record<InspectorDetent, string> = {
  dock: "Dock",
  half: "Half height",
  full: "Full height",
};

const TOUCH_TAP_SLOP_PX = 8;

function Name({ name, onRename }: Pick<InspectorBase, "name" | "onRename">) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!onRename) return <>{name}</>;
  const finish = (commit: boolean) => {
    const next = draft?.trim();
    setDraft(null);
    if (commit && next && next !== name) onRename(next);
  };
  return (
    <input
      className="sys-inspector-name"
      aria-label="Name"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? name}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

function Header({
  icon,
  name,
  onRename,
  onClose,
}: Pick<InspectorBase, "icon" | "name" | "onRename" | "onClose">) {
  return (
    <div className="sys-sheet-header sys-inspector-header">
      <SystemIcon name={icon} size={16} />
      <h2 className="sys-sheet-title">
        <Name name={name} onRename={onRename} />
      </h2>
      <CloseButton onClick={onClose} />
    </div>
  );
}

function Rows({ rows }: { rows: readonly InspectorRow[] }) {
  return rows.map((row) => (
    <div
      key={row.id}
      className="sys-inspector-row"
      data-unlabelled={row.label ? undefined : ""}
    >
      {row.label ? (
        <span className="sys-inspector-label">{row.label}</span>
      ) : null}
      <div className="sys-inspector-slot">{row.control}</div>
    </div>
  ));
}

function Section({ section }: { section: InspectorSection }) {
  const [collapsed, setCollapsed] = useState(
    Boolean(section.title && section.defaultCollapsed),
  );
  const bodyId = useId();
  if (!section.title) {
    return (
      <div className="sys-inspector-section">
        <div className="sys-inspector-rows">
          <Rows rows={section.rows} />
        </div>
      </div>
    );
  }
  return (
    <div
      className="sys-inspector-section"
      data-collapsed={collapsed || undefined}
    >
      <h3 className="sys-inspector-heading">
        <button
          type="button"
          className="sys-inspector-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((was) => !was)}
        >
          <SystemIcon name="chevron-down" size={14} />
          {section.title}
        </button>
      </h3>
      <div id={bodyId} className="sys-inspector-rows" hidden={collapsed}>
        <Rows rows={section.rows} />
      </div>
    </div>
  );
}

function Sections({ sections }: { sections: readonly InspectorSection[] }) {
  return (
    <div className="sys-inspector-scroll">
      {sections.map((section) => (
        <Section key={section.id} section={section} />
      ))}
    </div>
  );
}

/** Escape closes, unless a field inside took it for itself. */
function closeOnEscape(onClose: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.stopPropagation();
    onClose();
  };
}

function Card({
  icon,
  name,
  label,
  onRename,
  sections,
  onClose,
  anchor,
  bounds,
}: InspectorCardProps) {
  const place = placeCard(
    anchor,
    bounds,
    (CARD_WIDTH_PX * (rootRem() || DEFAULT_ROOT_PX)) / DEFAULT_ROOT_PX,
  );
  const style: CSSProperties = {
    insetInlineStart: place.inline,
    maxBlockSize: place.maxBlock,
    ...(place.side === "below"
      ? { insetBlockStart: place.block }
      : { insetBlockEnd: place.block }),
  };
  return (
    <section
      className="sys-sheet sys-inspector sys-inspector--card"
      role="dialog"
      aria-modal="false"
      aria-label={label ?? name}
      data-side={place.side}
      style={style}
    >
      <div
        role="presentation"
        className="sys-inspector-keys"
        onKeyDown={closeOnEscape(onClose)}
      >
        <Header icon={icon} name={name} onRename={onRename} onClose={onClose} />
        <Sections sections={sections} />
      </div>
    </section>
  );
}

const DOCK_REM = 4;
const DEFAULT_ROOT_PX = 16;
const DOCK_TOLERANCE_PX = 0.5;

function rootRem() {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

type Drag = {
  start: number;
  container: number;
  dock: number;
  height: number;
};

function Phone({
  icon,
  name,
  label,
  onRename,
  sections,
  onClose,
  dock,
  detent,
  onDetentChange,
  onDismiss,
}: InspectorPhoneProps) {
  const sheet = useRef<HTMLElement>(null);
  const samples = useRef<Sample[]>([]);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const grab = useGrab<"grip">({
    axis: "y",
    slop: (_grip, event) =>
      event.pointerType === "mouse" ? HANDLE_DRAG_MIN_PX : TOUCH_TAP_SLOP_PX,
    canGrab: () => true,
    onStart: () => {
      const el = sheet.current;
      const container = el?.parentElement?.clientHeight;
      if (!el || !container) return false;
      const start = el.getBoundingClientRect().height;
      const dock =
        el
          .querySelector<HTMLElement>(".sys-inspector-dock")
          ?.getBoundingClientRect().height ||
        rootRem() * DOCK_REM ||
        DOCK_PX;
      drag.current = { start, container, dock, height: start };
      samples.current = [{ t: performance.now(), height: start }];
      setDragging(start);
      return true;
    },
    onMove: (_grip, move) => {
      const gesture = drag.current;
      if (!gesture) return;
      gesture.height = dragHeight(gesture.start, move.dy, gesture.container);
      samples.current = [
        ...samples.current.slice(-1),
        { t: performance.now(), height: gesture.height },
      ];
      setDragging(gesture.height);
    },
    onEnd: (_grip, committed) => {
      const gesture = drag.current;
      drag.current = null;
      setDragging(null);
      if (!gesture || !committed) return;
      const next = settleDetent(
        gesture.height,
        riseVelocity(samples.current, performance.now()),
        gesture.container,
        gesture.start <= gesture.dock + DOCK_TOLERANCE_PX,
        gesture.dock,
      );
      if (next === "dismiss") onDismiss();
      else if (next !== detent) onDetentChange(next);
    },
  });
  const onGripKey = (event: KeyboardEvent<HTMLElement>) => {
    const next =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? steppedDetent(detent, 1)
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? steppedDetent(detent, -1)
          : event.key === "Home"
            ? "dock"
            : event.key === "End"
              ? "full"
              : event.key === "Enter" || event.key === " "
                ? toggledDetent(detent)
                : null;
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== detent) onDetentChange(next);
  };
  const style =
    dragging === null
      ? undefined
      : ({ "--sys-inspector-h": `${dragging}px` } as CSSProperties);
  return (
    <section
      ref={sheet}
      className="sys-inspector sys-inspector--phone"
      role="dialog"
      aria-modal="false"
      aria-label={label ?? name}
      data-detent={detent}
      data-dragging={dragging === null ? undefined : ""}
      style={style}
    >
      <div
        role="presentation"
        className="sys-inspector-keys"
        onKeyDown={closeOnEscape(onClose)}
      >
        <div
          className="sys-inspector-grip"
          role="slider"
          tabIndex={0}
          aria-label="Sheet height"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={2}
          aria-valuenow={INSPECTOR_DETENTS.indexOf(detent)}
          aria-valuetext={DETENT_TEXT[detent]}
          {...grab.handlers("grip")}
          onClick={(event) => {
            if (grab.consumeClick(event)) return;
            onDetentChange(toggledDetent(detent));
          }}
          onKeyDown={onGripKey}
        >
          <span className="sys-inspector-grip-bar" aria-hidden="true" />
        </div>
        <div className="sys-sheet sys-inspector-surface">
          <div className="sys-inspector-dock">{dock}</div>
          <div
            className="sys-inspector-content"
            inert={detent === "dock" && dragging === null}
          >
            <Header
              icon={icon}
              name={name}
              onRename={onRename}
              onClose={onClose}
            />
            <Sections sections={sections} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The Inspector sheet (design system 9a). A card of header, collapsible sections
 * and rows of label and control on desktop and tablet, and a bottom sheet with
 * three detents on phone. It owns the frame and the gestures; the host owns the
 * values, which apply as they change.
 */
export function InspectorSheet(props: InspectorSheetProps) {
  return props.form === "card" ? <Card {...props} /> : <Phone {...props} />;
}
