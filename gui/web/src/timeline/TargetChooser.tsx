/**
 * Touch target chooser (#1051 candidate A, lab `touchChooser`): when a held
 * finger covers several timeline targets, each fans out as a 44 px chip that
 * draws the target's own glyph at twice its size, joined by a leader line to
 * where it really is. `hitRouting` owns the gesture; this view only draws the
 * `ChooserView` it publishes and hands chip picks back to the router.
 */
import { usePress } from "@react-aria/interactions";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { JOIN_GLYPH_PATH, type JoinGlyph } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import { useMenuKeyboard } from "../ui/useMenuKeyboard";
import { formatTime } from "../utils/time";
import {
  type ChooserBounds,
  type ChooserItem,
  chooserItems,
  layoutChips,
} from "./chooserLayout";
import {
  CHOOSER_ITEM_ATTR,
  type ChooserView,
  type HitRouter,
} from "./hitRouting";
import { hitDetail, hitTimeSec, type ResolvedHit } from "./hitTargets";
import { type DragAxis, HIT_KINDS, type HitKind } from "./inputContract";

/** Kind label, plus the envelope gain the dot stands for. */
function chipTitle(hit: ResolvedHit): string {
  const label = HIT_KINDS[hit.candidate.kind].label;
  const detail = hitDetail(hit.element);
  return hit.candidate.kind === "envelope-point" && detail
    ? `${label} ${detail}×`
    : label;
}

/** The clip colour under the target, so its glyph keeps its real contrast. */
function chipSurface(hit: ResolvedHit): string | undefined {
  const { x, y } = hit.candidate;
  const clip = [hit.element, ...(document.elementsFromPoint?.(x, y) ?? [])]
    .map((el) => el.closest(".clip-block"))
    .find((el) => el instanceof HTMLElement);
  return clip instanceof HTMLElement
    ? clip.style.background || undefined
    : undefined;
}

/** In-chip text, only where the glyph alone repeats: an envelope point's gain. */
function chipTag(hit: ResolvedHit): string | null {
  const detail = hitDetail(hit.element);
  return hit.candidate.kind === "envelope-point" && detail
    ? `${detail}×`
    : null;
}

function TargetGlyph({
  kind,
  detail,
}: {
  kind: HitKind;
  detail: string | null;
}) {
  const mirror = kind.endsWith("-out") || kind === "pending-end";
  const pending =
    kind.startsWith("pending") && detail ? ` target-glyph--${detail}` : "";
  return (
    <svg
      className={`target-glyph target-glyph--${kind}${pending}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={mirror ? "matrix(-1 0 0 1 24 0)" : undefined}>
        {kind === "envelope-point" ? <circle cx="12" cy="12" r="10" /> : null}
        {kind === "fade-in" || kind === "fade-out" ? (
          <>
            <path className="target-glyph-line" d="M1 23C9 22 15 15 17 1" />
            <rect
              className="target-glyph-handle"
              x="11"
              y="0.5"
              width="12"
              height="12"
            />
          </>
        ) : null}
        {kind === "trim-in" || kind === "trim-out" ? (
          <>
            <rect
              className="target-glyph-handle"
              x="4"
              y="0.5"
              width="16"
              height="23"
            />
            <path className="target-glyph-line" d="M20 0.5V23.5" />
          </>
        ) : null}
        {kind === "roll" ? (
          <path className="target-glyph-seam" d="M12 0V24" />
        ) : null}
        {kind === "join" ? (
          <>
            <rect
              className="target-glyph-badge"
              x="2"
              y="5"
              width="20"
              height="14"
              rx="3"
            />
            <svg x="7" y="7" width="10" height="10" viewBox="0 0 12 12">
              <path
                className="target-glyph-badge-path"
                d={JOIN_GLYPH_PATH[detail as JoinGlyph] ?? ""}
              />
            </svg>
          </>
        ) : null}
        {kind === "pending-start" || kind === "pending-end" ? (
          <>
            <rect
              className="target-glyph-region"
              x="10"
              y="0.5"
              width="14"
              height="23"
            />
            <path className="target-glyph-edge" d="M10 0.5V23.5" />
          </>
        ) : null}
        {kind === "pending-flag" ? (
          <rect
            className="target-glyph-flag"
            x="9"
            y="0.5"
            width="6"
            height="23"
          />
        ) : null}
        {kind === "social-clip" ? (
          <rect
            className="target-glyph-social"
            x="2"
            y="8"
            width="20"
            height="8"
            rx="2"
          />
        ) : null}
        {kind === "chapter" ? (
          <rect
            className="target-glyph-diamond"
            x="6"
            y="6"
            width="12"
            height="12"
            transform="rotate(45 12 12)"
          />
        ) : null}
      </g>
    </svg>
  );
}

/** The held finger's choices on a chip, by the target's drag axis. */
const DRAG_HINT: Record<DragAxis, string> = {
  x: "Slide sideways to drag · lift to select",
  xy: "Slide to drag · lift to select",
  none: "Lift to select",
};

/**
 * Chevrons on an armed chip's edges, pointing the ways a slide drags it:
 * sideways for a time-only target, every way for an envelope point.
 */
function AxisCue({ axis }: { axis: DragAxis }) {
  return (
    <svg
      className="target-chip-axis"
      viewBox="0 0 44 44"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 17 2 22l4 5M38 17l4 5-4 5" />
      {axis === "xy" ? <path d="M17 6l5-4 5 4M17 38l5 4 5-4" /> : null}
    </svg>
  );
}

/** A chip button: a press by any input (touch, mouse, keys, AT) picks it. */
function Chip({
  onPick,
  ...props
}: Omit<ComponentPropsWithoutRef<"button">, "onClick" | "type"> & {
  onPick: (pointerType: string) => void;
}) {
  const { pressProps } = usePress({ onPress: (e) => onPick(e.pointerType) });
  return (
    <button
      type="button"
      {...props}
      {...pressProps}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        // No compatibility mousedown: it would land on the timeline once the
        // chooser unmounts and pull focus off the picked target.
        e.preventDefault();
        pressProps.onPointerDown?.(e);
      }}
    />
  );
}

export interface TargetChooserProps {
  view: ChooserView;
  router: HitRouter;
  /** The timeline's visible box; the chooser stays inside it. */
  bounds: ChooserBounds;
  /** Playing the close; inert, then `onClosed`. */
  closing: boolean;
  onClosed: () => void;
}

export function TargetChooser({
  view,
  router,
  bounds,
  closing,
  onClosed,
}: TargetChooserProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [chipPx, setChipPx] = useState(44);
  const [focused, setFocused] = useState<number | null>(null);
  const candidates = view.hits.map((h) => h.candidate);
  const items = chooserItems(candidates, view.page);
  const layout = layoutChips(items.length, view.origin, bounds, chipPx);
  const hidden = view.hits.length - items.length + 1;
  // One readable caption instead of a label per chip: it names the chip under
  // the finger, else the focused chip, else the best-ranked chip shown.
  const pageHits = items.flatMap((it) => (it.kind === "hit" ? [it.index] : []));
  const active =
    typeof view.over === "number"
      ? view.over
      : (focused ?? Math.min(...pageHits));
  const caption =
    view.over === "more"
      ? `${hidden} more targets`
      : `${chipTitle(view.hits[active])} · ${formatTime(hitTimeSec(view.hits[active].element))}`;

  useLayoutEffect(() => {
    // Layout size, not the painted box: the entrance scales chips from 0.4.
    const chip = panelRef.current?.querySelector<HTMLElement>(".target-chip");
    const width = chip?.offsetWidth;
    if (width) setChipPx(width);
  }, []);
  useMenuKeyboard({
    open: !closing,
    panelRef,
    close: router.close,
    orientation: "horizontal",
  });
  useEffect(() => {
    useDawStore.getState().announceStatus(`${view.hits.length} targets here`);
  }, [view.hits.length]);
  useEffect(() => {
    if (!closing) return;
    // The close animation's end unmounts the chooser; this is its backstop.
    const done = setTimeout(onClosed, 200);
    return () => clearTimeout(done);
  }, [closing, onClosed]);

  const chip = (item: ChooserItem, i: number) => {
    const center = layout.centers[i];
    const style = {
      left: center.x,
      top: center.y,
      "--chip-from-x": `${view.origin.x - center.x}px`,
      "--chip-from-y": `${view.origin.y - center.y}px`,
    } as CSSProperties;
    if (item.kind === "more") {
      return (
        <Chip
          key="more"
          role="menuitem"
          tabIndex={-1}
          className={`target-chip target-chip--more${view.over === "more" ? " is-over" : ""}`}
          style={style}
          {...{ [CHOOSER_ITEM_ATTR]: "more" }}
          aria-label={`More targets, ${hidden} not shown`}
          onFocus={() => setFocused(null)}
          onPick={() => router.nextPage()}
        >
          <span className="target-chip-more" aria-hidden="true">
            +{hidden}
          </span>
        </Chip>
      );
    }
    const arming = view.fingerDown && view.over === item.index;
    const hit = view.hits[item.index];
    const { kind, selected } = hit.candidate;
    const { axis } = HIT_KINDS[kind];
    const armed = arming && view.armed && axis !== "none";
    const time = formatTime(hitTimeSec(hit.element));
    const surface = chipSurface(hit);
    const tag = chipTag(hit);
    return (
      <Chip
        key={`${kind}-${hit.candidate.id}`}
        role="menuitemradio"
        aria-checked={selected}
        tabIndex={-1}
        className={`target-chip${tag ? " has-tag" : ""}${view.over === item.index ? " is-over" : ""}${arming ? " is-arming" : ""}${armed ? " is-armed" : ""}`}
        style={
          surface
            ? ({ ...style, "--chip-surface": surface } as CSSProperties)
            : style
        }
        {...{ [CHOOSER_ITEM_ATTR]: String(item.index) }}
        aria-label={`${chipTitle(hit)} at ${time}`}
        onFocus={() => setFocused(item.index)}
        onPick={(pointerType) => router.choose(item.index, pointerType)}
      >
        <TargetGlyph kind={kind} detail={hitDetail(hit.element)} />
        {tag ? (
          <span className="target-chip-tag" aria-hidden="true">
            {tag}
          </span>
        ) : null}
        {armed ? <AxisCue axis={axis} /> : null}
      </Chip>
    );
  };

  return createPortal(
    <div
      className={`target-chooser${closing ? " is-closing" : ""}`}
      data-placement={layout.placement}
      inert={closing}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) onClosed();
      }}
    >
      <div
        className="target-chooser-scrim"
        onPointerDown={(e) => {
          e.preventDefault();
          router.close();
        }}
      />
      <svg
        className="target-chooser-leaders"
        aria-hidden="true"
        focusable="false"
      >
        {items.map((item, i) => {
          if (item.kind === "more") return null;
          const { x, y } = view.hits[item.index].candidate;
          const c = layout.centers[i];
          return (
            <g key={item.index}>
              <line x1={c.x} y1={c.y} x2={x} y2={y} />
              <circle cx={x} cy={y} r="4" />
            </g>
          );
        })}
      </svg>
      <div
        ref={panelRef}
        className="target-chooser-menu"
        role="menu"
        aria-label="Targets here"
      >
        {items.map(chip)}
      </div>
      <p
        className="target-chooser-caption"
        style={{ left: layout.caption.x, top: layout.caption.y }}
        aria-hidden="true"
      >
        {caption}
        {view.fingerDown && typeof view.over === "number" ? (
          <span className="target-chooser-hint">
            {DRAG_HINT[HIT_KINDS[view.hits[view.over].candidate.kind].axis]}
          </span>
        ) : null}
      </p>
    </div>,
    document.body,
  );
}
