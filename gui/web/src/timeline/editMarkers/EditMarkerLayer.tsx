import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { capabilityTooltip } from "../../capabilities/copy";
import { joinSeamLabel } from "../../edit/joinRender";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { EDIT_GLYPH_PATH, EDIT_MARKERS } from "../../utils/editMarkerRegistry";
import { hitTargetProps } from "../hitTargets";
import {
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

const chipCount = (chip: PlacedChip) =>
  chip.marks.length > 99 ? "99+" : chip.marks.length;

type Register = (key: string) => (el: HTMLElement | null) => void;

/**
 * Decorative text beside the tag (the button's name already says it). It is
 * measured once, hidden until then, and dropped when `roomPx` cannot hold it.
 */
function MarkLabel({
  text,
  roomPx,
  xPx,
}: {
  text: string;
  roomPx: number;
  xPx: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [measured, setMeasured] = useState<{
    text: string;
    widthPx: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (ref.current && measured?.text !== text) {
      setMeasured({ text, widthPx: ref.current.scrollWidth });
    }
  }, [text, measured]);
  const known = measured?.text === text;
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
}: {
  symbol: PlacedSymbol;
  open: boolean;
  onClick: () => void;
  register: Register;
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
        style={{ left: xPx }}
        aria-label={`${joinSeamLabel(mark.kind, mark.sec)}${blocked ? ", will not blend" : ""}`}
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
        <MarkLabel text={symbol.label} roomPx={symbol.roomPx} xPx={xPx} />
      ) : null}
    </>
  );
}

export function EditMarkerLayer({ plan, onZoomChip }: EditMarkerLayerProps) {
  const { openJoinId, setOpenJoinId } = useDaw((s) => ({
    openJoinId: s.openJoinId,
    setOpenJoinId: s.setOpenJoinId,
  }));
  const toggle = (clipId: string) => {
    if (useDawStore.getState().joinMutationInFlight) {
      return;
    }
    setOpenJoinId(openJoinId === clipId ? null : clipId);
  };
  const elements = useRef(new Map<string, HTMLElement>());
  const register: Register = (key) => (el) => {
    if (el) {
      elements.current.set(key, el);
    } else {
      elements.current.delete(key);
    }
  };
  // A zoom that splits a chip unmounts the focused button: focus moves to
  // the first member's glyph, or the chip still holding it.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const id = refocus.current;
    refocus.current = null;
    if (id == null) {
      return;
    }
    const chip = plan.chips.find(({ marks }) => marks.some((m) => m.id === id));
    elements.current
      .get(chip ? chip.marks[0].id : id)
      ?.focus({ preventScroll: true });
  }, [plan]);
  return (
    <>
      {plan.symbols.map((symbol) => (
        <Glyph
          key={symbol.mark.id}
          symbol={symbol}
          open={openJoinId === symbol.mark.clipId}
          onClick={() => toggle(symbol.mark.clipId)}
          register={register}
        />
      ))}
      {plan.chips.map((chip) =>
        chip.zoomTo == null ? (
          <span
            key={chip.marks[0].id}
            className="edit-chip edit-chip--static"
            role="img"
            style={{ left: chip.xPx }}
            aria-label={chipLabel(chip)}
          >
            {chipCount(chip)}
          </span>
        ) : (
          <button
            key={chip.marks[0].id}
            ref={register(chip.marks[0].id)}
            type="button"
            className="edit-chip"
            {...hitTargetProps("edit-chip", chip.marks[0].id, chip.startSec, {
              spanSec: chip.endSec - chip.startSec,
            })}
            style={{ left: chip.xPx }}
            aria-label={chipLabel(chip)}
            onClick={() => {
              refocus.current = chip.marks[0].id;
              onZoomChip(chip);
            }}
          >
            {chipCount(chip)}
          </button>
        ),
      )}
    </>
  );
}
