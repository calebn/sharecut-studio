import { useEffect, useRef } from "react";
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

type Register = (key: string) => (el: HTMLElement | null) => void;

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
  const { mark, xPx } = symbol;
  const { type } = EDIT_MARKERS[mark.kind];
  const blocked = mark.right.join_crossfade_blocked != null;
  return (
    <button
      ref={register(mark.id)}
      type="button"
      className={`edit-mark edit-mark--${type}${blocked ? " edit-mark--blocked" : ""}`}
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
      <svg
        className="edit-mark-glyph"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <path d={EDIT_GLYPH_PATH[type]} />
      </svg>
    </button>
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
            {chip.marks.length}
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
            {chip.marks.length}
          </button>
        ),
      )}
    </>
  );
}
