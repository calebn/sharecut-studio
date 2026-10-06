/**
 * Touch target chooser (#1051 candidate A, lab `touchChooser`): when a held
 * finger covers several timeline targets, each fans out as a 44 px chip that
 * draws the target's own glyph at twice its size, joined by a leader line to
 * where it really is. `hitRouting` owns the gesture; this view only draws the
 * `ChooserView` it publishes and hands chip picks back to the router.
 */
import {
  type CSSProperties,
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
import { type ChooserItem, chooserItems, layoutChips } from "./chooserLayout";
import { HIT_KINDS, type HitKind } from "./hitCandidates";
import {
  CHOOSER_ITEM_ATTR,
  type ChooserView,
  type HitRouter,
} from "./hitRouting";
import { hitDetail, hitTimeSec, type ResolvedHit } from "./hitTargets";

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

export interface TargetChooserProps {
  view: ChooserView;
  router: HitRouter;
  /** Playing the close; inert, then `onClosed`. */
  closing: boolean;
  onClosed: () => void;
}

export function TargetChooser({
  view,
  router,
  closing,
  onClosed,
}: TargetChooserProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [chipPx, setChipPx] = useState(44);
  const [focused, setFocused] = useState<number | null>(null);
  const candidates = view.hits.map((h) => h.candidate);
  const items = chooserItems(candidates, view.page);
  const layout = layoutChips(
    items.length,
    view.origin,
    { width: window.innerWidth, height: window.innerHeight },
    chipPx,
  );
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
        <button
          key="more"
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={`target-chip target-chip--more${view.over === "more" ? " is-over" : ""}`}
          style={style}
          {...{ [CHOOSER_ITEM_ATTR]: "more" }}
          aria-label={`More targets, ${hidden} not shown`}
          onFocus={() => setFocused(null)}
          onClick={() => router.nextPage()}
        >
          <span className="target-chip-more" aria-hidden="true">
            +{hidden}
          </span>
        </button>
      );
    }
    const hit = view.hits[item.index];
    const { kind, selected } = hit.candidate;
    const time = formatTime(hitTimeSec(hit.element));
    const surface = chipSurface(hit);
    const tag = chipTag(hit);
    return (
      <button
        key={`${kind}-${hit.candidate.id}`}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        tabIndex={-1}
        className={`target-chip${tag ? " has-tag" : ""}${view.over === item.index ? " is-over" : ""}`}
        style={
          surface
            ? ({ ...style, "--chip-surface": surface } as CSSProperties)
            : style
        }
        {...{ [CHOOSER_ITEM_ATTR]: String(item.index) }}
        aria-label={`${chipTitle(hit)} at ${time}`}
        onFocus={() => setFocused(item.index)}
        // No compatibility mousedown: it would land on the timeline once the
        // chooser unmounts and pull focus off the picked target.
        onPointerDown={(e) => e.preventDefault()}
        onPointerUp={(e) => router.choose(item.index, e.nativeEvent)}
        onClick={() => router.choose(item.index, null)}
      >
        <TargetGlyph kind={kind} detail={hitDetail(hit.element)} />
        {tag ? (
          <span className="target-chip-tag" aria-hidden="true">
            {tag}
          </span>
        ) : null}
      </button>
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
      </p>
    </div>,
    document.body,
  );
}
