import {
  type FocusEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { capabilityTooltip } from "../../capabilities/copy";
import { joinSeamLabel } from "../../edit/joinRender";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { useResizeObserver } from "../../ui";
import { EDIT_GLYPH_PATH, EDIT_MARKERS } from "../../utils/editMarkerRegistry";
import { hitTargetProps } from "../hitTargets";
import { ROUTER_TRACE, routerTrace } from "../routerTrace";
import {
  chipCount,
  chipLabel,
  joinPopoverId,
  type LanePlan,
  type PlacedChip,
  type PlacedSymbol,
} from "./plan";

interface EditMarkerLayerProps {
  plan: LanePlan;
  onZoomChip: (chip: PlacedChip) => void;
}

type Track = (id: string) => {
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
};

type Register = (key: string) => (el: HTMLElement | null) => void;

/**
 * A number that changes whenever label text may measure differently: a web
 * font finished loading, or the label's font size (a rem) resized. The probe
 * is as wide as the label's font size, so a root font-size change resizes it.
 */
function useTypographyEpoch() {
  const probe = useRef<HTMLSpanElement>(null);
  const [store] = useState(() => {
    let epoch = 0;
    const listeners = new Set<() => void>();
    const bump = () => {
      epoch += 1;
      for (const listener of listeners) {
        listener();
      }
    };
    return {
      bump,
      getSnapshot: () => epoch,
      // Attaching also refits once when a font load may already have ended.
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        const fonts = document.fonts;
        fonts?.addEventListener("loadingdone", bump);
        if (fonts && fonts.status !== "loaded") {
          bump();
        }
        return () => {
          listeners.delete(listener);
          fonts?.removeEventListener("loadingdone", bump);
        };
      },
    };
  });
  const epoch = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useResizeObserver(probe, store.bump);
  return { probe, epoch };
}

/**
 * Decorative text beside the tag (the button's name already says it). It is
 * measured per `epoch`, hidden until then, and dropped when `roomPx` cannot
 * hold it.
 */
function MarkLabel({
  text,
  roomPx,
  xPx,
  epoch,
}: {
  text: string;
  roomPx: number;
  xPx: number;
  epoch: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{
    text: string;
    epoch: number;
    widthPx: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (ref.current && (measured?.text !== text || measured.epoch !== epoch)) {
      setMeasured({ text, epoch, widthPx: ref.current.scrollWidth });
    }
  }, [text, epoch, measured]);
  const known = measured?.text === text && measured.epoch === epoch;
  if (known && measured.widthPx > roomPx) {
    return null;
  }
  return (
    <span
      ref={ref}
      className="edit-mark-label"
      style={{ left: xPx }}
      aria-hidden="true"
      data-measured={known ? "" : undefined}
    >
      {text}
    </span>
  );
}

function Glyph({
  symbol,
  open,
  onClick,
  register,
  track,
  epoch,
}: {
  symbol: PlacedSymbol;
  open: boolean;
  onClick: () => void;
  register: Register;
  track: Track;
  epoch: number;
}) {
  const { mark, xPx, tier } = symbol;
  const { type } = EDIT_MARKERS[mark.kind];
  const blocked = mark.right.join_crossfade_blocked != null;
  return (
    <>
      <button
        ref={register(mark.id)}
        type="button"
        className={`edit-mark edit-mark--${type}${blocked ? " edit-mark--blocked" : ""}`}
        data-tier={tier}
        {...hitTargetProps("join", mark.clipId, mark.sec, {
          selected: open,
          detail: type,
        })}
        {...track(mark.id)}
        style={{ left: xPx }}
        aria-label={`${joinSeamLabel(mark.kind, mark.sec, symbol.label)}${blocked ? ", will not blend" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? joinPopoverId(mark.clipId) : undefined}
        title={capabilityTooltip("timeline.join.badge")}
        onClick={onClick}
      >
        <span className="edit-mark-face">
          <svg
            className="edit-mark-glyph"
            viewBox="0 0 12 12"
            aria-hidden="true"
            focusable="false"
          >
            <path d={EDIT_GLYPH_PATH[type]} />
          </svg>
        </span>
      </button>
      {symbol.labelAllowed ? (
        <MarkLabel
          text={symbol.label}
          roomPx={symbol.roomPx}
          xPx={xPx}
          epoch={epoch}
        />
      ) : null}
    </>
  );
}

export function EditMarkerLayer({ plan, onZoomChip }: EditMarkerLayerProps) {
  const { openJoinId, setOpenJoinId } = useDaw((s) => ({
    openJoinId: s.openJoinId,
    setOpenJoinId: s.setOpenJoinId,
  }));
  const popoverMark = useRef<string | null>(null);
  const toggle = (clipId: string) => {
    if (ROUTER_TRACE) {
      routerTrace("glyph-toggle", {
        clipId,
        openJoinId,
        inFlight: useDawStore.getState().joinMutationInFlight,
      });
    }
    if (useDawStore.getState().joinMutationInFlight) {
      return;
    }
    popoverMark.current = openJoinId === clipId ? null : `join-${clipId}`;
    setOpenJoinId(openJoinId === clipId ? null : clipId);
  };
  const { probe, epoch } = useTypographyEpoch();
  const elements = useRef(new Map<string, HTMLElement>());
  const register: Register = (key) => (el) => {
    if (el) {
      elements.current.set(key, el);
    } else {
      elements.current.delete(key);
    }
  };
  const items = useMemo(
    () =>
      [
        ...plan.symbols.map((symbol) => ({
          xPx: symbol.xPx,
          key: symbol.mark.id,
          ids: [symbol.mark.id],
          symbol,
          chip: null,
        })),
        ...plan.chips.map((chip) => ({
          xPx: chip.xPx,
          key: chip.marks[0].id,
          ids: chip.marks.map((m) => m.id),
          symbol: null,
          chip,
        })),
      ].sort((a, b) => a.xPx - b.xPx),
    [plan],
  );
  // A plan change can unmount the focused mark (a zoom merging it into a
  // chip, splitting its chip, or a chip going inert): focus moves to whatever
  // now holds its id, else the nearest button.
  const focused = useRef<string | null>(null);
  const track = (id: string) => ({
    onFocus: () => {
      focused.current = id;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const el = event.currentTarget;
      queueMicrotask(() => {
        if (el.isConnected && document.activeElement !== el) {
          focused.current = null;
        }
      });
    },
  });
  // Opening a join popover moves focus into the dialog, which clears
  // `focused`; the mark whose glyph opened it stands in for it until the popover closes.
  useEffect(() => {
    const id = focused.current ?? popoverMark.current;
    if (id == null || document.activeElement !== document.body) {
      return;
    }
    const holder = items.find((item) => item.ids.includes(id));
    if (holder == null) {
      focused.current = null;
      return;
    }
    const target = elements.current.has(holder.key)
      ? holder.key
      : items
          .filter((item) => elements.current.has(item.key))
          .sort(
            (a, b) =>
              Math.abs(a.xPx - holder.xPx) - Math.abs(b.xPx - holder.xPx),
          )[0]?.key;
    if (target != null) {
      elements.current.get(target)?.focus({ preventScroll: true });
    }
  }, [items]);
  // After the restore effect above, so a fold that closes the popover in the
  // same commit still finds its mark.
  useEffect(() => {
    if (openJoinId == null) {
      popoverMark.current = null;
    }
  }, [openJoinId]);
  return (
    <>
      <span ref={probe} className="edit-mark-probe" aria-hidden="true" />
      {items.map((item) =>
        item.symbol ? (
          <Glyph
            key={item.symbol.mark.id}
            symbol={item.symbol}
            open={openJoinId === item.symbol.mark.clipId}
            onClick={() => toggle(item.symbol.mark.clipId)}
            register={register}
            track={track}
            epoch={epoch}
          />
        ) : item.chip.zoomTo == null ? (
          <span
            key={item.chip.marks[0].id}
            className="edit-chip edit-chip--static"
            role="img"
            style={{ left: item.chip.xPx }}
            aria-label={chipLabel(item.chip)}
          >
            {chipCount(item.chip)}
          </span>
        ) : (
          <button
            key={item.chip.marks[0].id}
            ref={register(item.chip.marks[0].id)}
            type="button"
            className="edit-chip"
            {...hitTargetProps(
              "edit-chip",
              item.chip.marks[0].id,
              item.chip.startSec,
              {
                spanSec: item.chip.endSec - item.chip.startSec,
              },
            )}
            {...track(item.chip.marks[0].id)}
            style={{ left: item.chip.xPx }}
            aria-label={chipLabel(item.chip)}
            onClick={() => {
              focused.current = item.chip.marks[0].id;
              onZoomChip(item.chip);
            }}
          >
            {chipCount(item.chip)}
          </button>
        ),
      )}
    </>
  );
}
