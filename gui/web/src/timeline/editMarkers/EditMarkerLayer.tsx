import { capabilityTooltip } from "../../capabilities/copy";
import { joinSeamLabel } from "../../edit/joinRender";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { EDIT_GLYPH_PATH, markerType } from "../../utils/editMarkerRegistry";
import { hitTargetProps } from "../hitTargets";
import {
  chipLabel,
  joinPopoverId,
  type LanePlan,
  type PlacedSymbol,
} from "./plan";

interface EditMarkerLayerProps {
  plan: LanePlan;
  onZoomToSpan: (startSec: number, endSec: number) => void;
}

function Glyph({
  symbol,
  open,
  onClick,
}: {
  symbol: PlacedSymbol;
  open: boolean;
  onClick: () => void;
}) {
  const { mark, tier, xPx } = symbol;
  const type = markerType(mark.kind);
  const blocked = mark.blocked != null;
  return (
    <button
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

export function EditMarkerLayer({ plan, onZoomToSpan }: EditMarkerLayerProps) {
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
  return (
    <>
      {plan.symbols.map((symbol) => (
        <Glyph
          key={symbol.mark.id}
          symbol={symbol}
          open={openJoinId === symbol.mark.clipId}
          onClick={() => toggle(symbol.mark.clipId)}
        />
      ))}
      {plan.chips.map((chip) => (
        <button
          key={chip.marks[0].id}
          type="button"
          className="edit-chip"
          {...hitTargetProps("edit-chip", chip.marks[0].id, chip.startSec, {
            spanSec: chip.endSec - chip.startSec,
          })}
          style={{ left: chip.xPx }}
          aria-label={chipLabel(chip)}
          onClick={() => onZoomToSpan(chip.startSec, chip.endSec)}
        >
          {chip.marks.length}
        </button>
      ))}
    </>
  );
}
